import { useId, type InputHTMLAttributes } from "react";

/**
 * A labelled input with its hint and error wired up for assistive technology:
 * the label names it, and the hint and error describe it.
 */
export function Field({
  label,
  hint,
  error,
  ...input
}: { label: string; hint?: string; error?: string | null } & InputHTMLAttributes<HTMLInputElement>) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint === undefined ? null : hintId, error == null ? null : errorId].filter(v => v !== null).join(" ");
  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>{label}</label>
      {hint === undefined ? null : <p className="field__hint" id={hintId}>{hint}</p>}
      <input
        {...input}
        id={id}
        className="field__input"
        aria-invalid={error == null ? undefined : true}
        aria-describedby={describedBy === "" ? undefined : describedBy}
      />
      {error == null ? null : <p className="field__error" id={errorId}>{error}</p>}
    </div>
  );
}

/** A form-level message: an error is announced, a confirmation is polite. */
export function FormMessage({ tone, children }: { tone: "error" | "success" | "info"; children: string }) {
  return (
    <p className={`form-message form-message--${tone}`} role={tone === "error" ? "alert" : "status"}>
      {children}
    </p>
  );
}
