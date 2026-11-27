import { createCipheriv, randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const root = process.env.RUNNER_TEMP;
const key = Buffer.from(process.env.IC_RELEASE_SNAPSHOT_KEY.trim(), "hex");
const iv = randomBytes(12);
const cipher = createCipheriv("aes-256-gcm", key, iv);
const log = await readFile(path.join(root, "ic-native-build.log"));
const encrypted = Buffer.concat([cipher.update(log), cipher.final()]);
await writeFile(path.join(root, "ic-native-build.log.enc"), Buffer.concat([iv, cipher.getAuthTag(), encrypted]));
