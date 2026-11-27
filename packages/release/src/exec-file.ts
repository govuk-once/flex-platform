import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

/** Runs a command without a shell, and answers with what it wrote once it exits. */
export const execFile = promisify(execFileCallback);
