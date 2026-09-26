export interface AccountDisplayIdentity {
  name: string;
  email: string | null;
}

function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

export function formatAccountEmail(email: string | null, show: boolean): string | null {
  if (!email) return null;
  if (show) return email;
  const at = email.indexOf("@");
  if (at <= 0) return "••••••";
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  return `${local.slice(0, 1)}${"•".repeat(Math.min(5, Math.max(2, local.length - 1)))}@${domain}`;
}

/** Treat an email copied into an account name as email content for privacy. */
export function formatAccountDisplayName(account: AccountDisplayIdentity, showEmail: boolean): string {
  const name = account.name?.trim() || "";
  const email = account.email?.trim() || null;
  const nameIsEmail = Boolean(
    (email && name.toLocaleLowerCase() === email.toLocaleLowerCase())
      || (!email && looksLikeEmail(name)),
  );
  if (nameIsEmail) return formatAccountEmail(email || name, showEmail) || name || "Codex account";
  if (!name) return formatAccountEmail(email, showEmail) || "Codex account";
  if (!showEmail && email) {
    const nameStart = name.toLocaleLowerCase().indexOf(email.toLocaleLowerCase());
    if (nameStart >= 0) {
      const masked = formatAccountEmail(email, false) || "••••••";
      return `${name.slice(0, nameStart)}${masked}${name.slice(nameStart + email.length)}`;
    }
  }
  return name;
}
