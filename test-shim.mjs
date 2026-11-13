// Local-test only: the host patches schemastery with .volatile(); the plain npm
// package does not have it. Loaded via `node --import`, never shipped.
import z from "@deepseek-ai/schemastery";
const proto = Object.getPrototypeOf(z.string());
if (typeof proto.volatile !== "function") {
  proto.volatile = function volatile() { return this; };
}
