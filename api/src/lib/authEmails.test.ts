import { test } from "node:test";
import assert from "node:assert/strict";
import { escapeHtml, verificationEmail } from "./authEmails.js";
import { mailTransportFor } from "./mailer.js";

test("every user-controlled value is HTML-escaped in the HTML part, and left readable in the text part", () => {
  const hostileName = `<script>alert("x")</script>&'`;
  const link = `https://timesheets.example.com/verify-email#token=abc"onmouseover="x`;
  const message = verificationEmail({ userId: "user-1", to: "driver@example.com", firstName: hostileName, link });

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

test("with email disabled (the test default), every send FAILS loudly — never a silent no-op, never a fallback recipient", async () => {
  const { mailer } = mailTransportFor({ MAIL_TRANSPORT: "disabled", AWS_REGION: "us-east-1", AWS_ACCESS_KEY_ID: "", AWS_SECRET_ACCESS_KEY: "" });
  await assert.rejects(mailer.send({ sender: "accounts", userId: "user-1", to: "a@example.com", subject: "s", text: "t", html: "h" }));
});

test("verification comes from accounts@, a password reset from security@", async () => {
  const { passwordResetEmail } = await import("./authEmails.js");
  assert.equal(verificationEmail({ userId: "user-1", to: "a@example.com", firstName: "A", link: "https://t.example.com/verify-email#token=x" }).sender, "accounts");
  assert.equal(passwordResetEmail({ userId: "user-1", to: "a@example.com", firstName: "A", link: "https://t.example.com/reset-password#token=x" }).sender, "security");
});

test("the password-reset email escapes the same way and goes only to the account's own address", async () => {
  const { passwordResetEmail } = await import("./authEmails.js");
  const message = passwordResetEmail({ userId: "user-1", to: "driver@example.com", firstName: "<b>Pat</b>", link: "https://t.example.com/reset-password#token=a&b" });
  assert.equal(message.to, "driver@example.com");
  assert.ok(message.html.includes("&lt;b&gt;Pat&lt;/b&gt;"));
  assert.ok(message.html.includes("#token=a&amp;b"));
  assert.ok(!message.html.includes("<b>Pat</b>"));
});
