import { test } from "node:test";
import assert from "node:assert/strict";
import { escapeHtml, verificationEmail } from "./authEmails.js";
import { mailerFor } from "./mailer.js";

test("every user-controlled value is HTML-escaped in the HTML part, and left readable in the text part", () => {
  const hostileName = `<script>alert("x")</script>&'`;
  const link = `https://timesheets.example.com/verify-email#token=abc"onmouseover="x`;
  const message = verificationEmail({ to: "driver@example.com", firstName: hostileName, link });

  assert.equal(message.to, "driver@example.com", "sent only to the account's own address");
  assert.ok(!message.html.includes("<script>"), "no markup from a name survives");
  assert.ok(message.html.includes("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;&#39;"));
  assert.ok(!message.html.includes(`"onmouseover="`), "a quote cannot break out of the href");
  assert.ok(message.text.includes(hostileName), "the plain-text part is text, unescaped");
  assert.ok(message.text.includes(link));
});

test("escapeHtml covers the five significant characters and nothing else", () => {
  assert.equal(escapeHtml(`&<>"'`), "&amp;&lt;&gt;&quot;&#39;");
  assert.equal(escapeHtml("Ąžuolas O'Neil"), "Ąžuolas O&#39;Neil");
});

test("in test with no key, every send FAILS loudly — never a silent no-op, never a fallback recipient", async () => {
  const mailer = mailerFor({ SENDGRID_API_KEY: "", MAIL_FROM: "timesheets@logisticbay.com", NODE_ENV: "test" });
  await assert.rejects(mailer.send({ to: "a@example.com", subject: "s", text: "t", html: "h" }));
});
