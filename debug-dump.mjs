import { discoverAccounts } from "./debug-index.mjs";
const accounts = discoverAccounts();
for (const a of accounts) console.log([a.region, "uid=" + (a.uid ? a.uid.slice(0, 8) : "-"), "exp=" + (a.expiresAt ? new Date(a.expiresAt).toISOString().slice(0, 10) : "-"), "src=" + a.source.split("\\").slice(-2).join("/")].join(" | "));
console.log("total=", accounts.length);
console.log("ai=", accounts.filter((a) => a.region === "ai").length, "cn=", accounts.filter((a) => a.region === "cn").length);
