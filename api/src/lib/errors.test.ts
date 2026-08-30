import { test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyReply } from "fastify";
import { badRequest, unauthorized, forbidden, notFound, conflict, serverError } from "./errors.js";

interface Captured { status: number; body: unknown }

function fakeReply(): { reply: FastifyReply; captured: Captured } {
  const captured: Captured = { status: 0, body: undefined };
  const reply = {
    status(code: number) { captured.status = code; return this; },
    send(body: unknown) { captured.body = body; return this; },
  } as unknown as FastifyReply;
  return { reply, captured };
}

test("each helper sends its documented status code", () => {
  const cases: Array<[(r: FastifyReply) => unknown, number]> = [
    [r => badRequest(r, "bad"), 400],
    [r => unauthorized(r),      401],
    [r => forbidden(r),         403],
    [r => notFound(r),          404],
    [r => conflict(r, "clash"), 409],
    [r => serverError(r),       500],
  ];
  for (const [call, expected] of cases) {
    const { reply, captured } = fakeReply();
    call(reply);
    assert.equal(captured.status, expected);
  }
});

test("omits code and details when they are not supplied", () => {
  const { reply, captured } = fakeReply();
  badRequest(reply, "just a message");
  assert.deepEqual(captured.body, { error: "just a message" });
});

test("includes code and details when supplied", () => {
  const { reply, captured } = fakeReply();
  badRequest(reply, "nope", "SHIFT_ALREADY_SUBMITTED", { shiftId: "abc" });
  assert.deepEqual(captured.body, {
    error: "nope",
    code: "SHIFT_ALREADY_SUBMITTED",
    details: { shiftId: "abc" },
  });
});

test("defaults carry a human-readable message", () => {
  const { reply, captured } = fakeReply();
  unauthorized(reply);
  assert.deepEqual(captured.body, { error: "Not authenticated" });
});
