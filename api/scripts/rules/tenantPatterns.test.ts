import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MEMBER_ACCESS,
  readsCompanyIdByMemberAccess,
  findRequestDestructures,
  stripComments,
  passesRawRequestToCall,
  declaresCompanyIdInSchema,
} from "./tenantPatterns.js";

// ── Member access — tested against MEMBER_ACCESS directly ────────────────────
// Asserting on the specific pattern, not just the public predicate, so deleting
// this mechanism makes THIS test fail rather than being masked by another.

const MEMBER_ACCESS_CAUGHT = [
  "const companyId = req.body.companyId;",
  "const companyId = request.body.companyId;",
  "const id = req.query.companyId;",
  "const id = request.params.companyId;",
  'const id = req.body["companyId"];',
  "const id = req.body['companyId'];",
  "const id = r.body.companyId;",                        // handler param not named req
  "app.get('/x', async (ctx) => ctx.query.companyId);",  // arbitrary receiver
  "const body = req.body; const companyId = body.companyId;",  // aliased, second read
  "return prisma.shift.findMany({ where: { companyId: req.body.companyId } });",
];

test("MEMBER_ACCESS catches every direct and bracket read of companyId", () => {
  for (const line of MEMBER_ACCESS_CAUGHT) {
    assert.ok(MEMBER_ACCESS.test(stripComments(line)), `MEMBER_ACCESS should match: ${line}`);
  }
});

test("readsCompanyIdByMemberAccess agrees with MEMBER_ACCESS", () => {
  for (const line of MEMBER_ACCESS_CAUGHT) {
    assert.equal(readsCompanyIdByMemberAccess(line), true, `should be caught: ${line}`);
  }
});

// ── Destructuring — tested against findRequestDestructures directly ──────────

test("finds single-line destructuring of companyId from request input", () => {
  const hits = findRequestDestructures("const { companyId } = req.body;");
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.multiline, false);
});

test("finds destructuring with other keys alongside companyId", () => {
  assert.equal(findRequestDestructures("const { name, companyId } = req.body;").length, 1);
  assert.equal(findRequestDestructures("const { companyId: target } = req.params;").length, 1);
});

test("finds multi-line destructuring", () => {
  const source = ["const {", "  companyId,", "  name,", "} = req.body;"].join("\n");
  const hits = findRequestDestructures(source);
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.multiline, true);
  assert.equal(hits[0]?.line, 1);
});

test("finds NESTED multi-line destructuring (regex brace-matching could not)", () => {
  const source = ["const {", "  filters: { companyId },", "} = req.body;"].join("\n");
  const hits = findRequestDestructures(source);
  assert.equal(hits.length, 1, "nested destructure must be caught");
});

test("finds destructuring from an aliased request property", () => {
  assert.equal(findRequestDestructures("const { companyId } = body;").length, 1);
});

// ── Negative cases: legitimate code must stay legal ──────────────────────────
// These are the co-occurrence patterns an earlier catch-all wrongly blocked.
// If a future change reintroduces an over-broad rule, these fail.

const MUST_REMAIN_LEGAL = [
  "return svc.list(auth.companyId, req.query.status);",
  "const shifts = await listShifts({ companyId: auth.companyId }, req.query.page);",
  "app.log.info({ companyId: auth.companyId, path: req.params.id });",
  "reply.send({ companyId: auth.companyId, page: req.query.page });",
  "const seg = await create({ shiftId: req.params.id, companyId: auth.companyId });",
  "const companyId = auth.companyId;",
  "where: { companyId: auth.companyId }",
  "const { membershipId } = req.body;",
  "const { userId } = req.body;",
  "const userId = req.body.userId;",
  "const body = req.body;",
  "const doc = 'see https://wiki/x'; const name = req.body.name;",
];

test("does not fire on legitimate co-occurrence of companyId and request input", () => {
  for (const line of MUST_REMAIN_LEGAL) {
    assert.equal(readsCompanyIdByMemberAccess(line), false, `false positive (member): ${line}`);
    assert.equal(findRequestDestructures(line).length, 0, `false positive (destructure): ${line}`);
  }
});

test("the switch-company handler shape stays legal", () => {
  const source = [
    "export async function switchCompany(req, reply, auth) {",
    "  const { membershipId } = req.body;",
    "  const companyId = auth.companyId;",
    "  return { membershipId, companyId };",
    "}",
  ].join("\n");
  for (const line of source.split("\n")) {
    assert.equal(readsCompanyIdByMemberAccess(line), false, `false positive: ${line}`);
  }
  assert.equal(findRequestDestructures(source).length, 0);
});

test("destructuring from a non-request source is ignored", () => {
  assert.equal(findRequestDestructures("const { companyId } = auth;").length, 0);
  assert.equal(findRequestDestructures("const {\n  companyId,\n} = ctx.context;").length, 0);
});

test("membershipId and userId are deliberately permitted everywhere", () => {
  assert.equal(readsCompanyIdByMemberAccess("const m = req.body.membershipId;"), false);
  assert.equal(findRequestDestructures("const {\n  membershipId,\n  userId,\n} = req.body;").length, 0);
});

// ── stripComments ────────────────────────────────────────────────────────────

test("stripComments removes line comments", () => {
  assert.equal(stripComments("code; // req.body.companyId").trim(), "code;");
});

test("stripComments removes block comments", () => {
  assert.equal(stripComments("a /* req.body.companyId */ b").replace(/\s+/g, " ").trim(), "a b");
});

test("stripComments does NOT truncate at // inside a string literal", () => {
  const line = 'const doc = "see https://wiki/x"; const c = req.body.companyId;';
  assert.match(stripComments(line), /req\.body\.companyId/);
  assert.equal(readsCompanyIdByMemberAccess(line), true, "URL must not disable the rule");
});

test("a comment describing the anti-pattern is not itself a violation", () => {
  assert.equal(readsCompanyIdByMemberAccess("// never read req.body.companyId"), false);
  assert.equal(findRequestDestructures("// const { companyId } = req.body;").length, 0);
});

// ── Route → service trust boundary ───────────────────────────────────────────

test("flags a raw request object handed to a service", () => {
  assert.equal(passesRawRequestToCall("return shiftService.create(auth, req.body);"), "shiftService.create");
  assert.equal(passesRawRequestToCall("return svc.list(req.query);"), "svc.list");
  assert.equal(passesRawRequestToCall("return svc.get(request.params);"), "svc.get");
  assert.equal(passesRawRequestToCall("return handle(req);"), "handle");
  assert.equal(passesRawRequestToCall("return svc.create(auth, body);"), "svc.create");
});

test("parsing is the one legitimate destination for raw input", () => {
  assert.equal(passesRawRequestToCall("const dto = CreateShift.parse(req.body);"), null);
  assert.equal(passesRawRequestToCall("const r = CreateShift.safeParse(req.query);"), null);
  assert.equal(passesRawRequestToCall("const r = await Schema.parseAsync(req.body);"), null);
});

test("does not flag validated DTOs or AuthContext crossing the boundary", () => {
  assert.equal(passesRawRequestToCall("return shiftService.create(auth, dto);"), null);
  assert.equal(passesRawRequestToCall("return svc.list(auth, { page: dto.page });"), null);
  assert.equal(passesRawRequestToCall("return svc.get(auth, req.params.id);"), null);
  assert.equal(passesRawRequestToCall("reply.send({ ok: true });"), null);
});

// ── Zod DTOs must not accept companyId ───────────────────────────────────────

test("flags a Zod schema declaring companyId", () => {
  assert.equal(declaresCompanyIdInSchema("  companyId: z.string().max(64),"), true);
  assert.equal(declaresCompanyIdInSchema("companyId: z.uuid(),"), true);
  assert.equal(declaresCompanyIdInSchema("  companyId : z . string ( ) ,"), true);
});

test("does not flag membershipId or userId in a Zod schema", () => {
  assert.equal(declaresCompanyIdInSchema("  membershipId: z.string().max(64),"), false);
  assert.equal(declaresCompanyIdInSchema("  userId: z.string().max(64),"), false);
});

test("does not flag companyId used as a value or a type", () => {
  assert.equal(declaresCompanyIdInSchema("where: { companyId: auth.companyId }"), false);
  assert.equal(declaresCompanyIdInSchema("interface Ctx { companyId: string }"), false);
  assert.equal(declaresCompanyIdInSchema("return { companyId: auth.companyId };"), false);
});
