/**
 * Downloads the sentence-transformer weights into ./models so that both the
 * ingestion pipeline and the Vercel runtime can embed text locally.
 *
 * The weights are committed to the repository on purpose: it makes builds
 * hermetic and removes the Hugging Face CDN from the production request path.
 *
 *   npm run model:fetch
 *   npm run model:fetch -- --force   re-download even if files are present
 */
import { createHash } from "node:crypto";
import { mkdir, writeFile, access } from "node:fs/promises";
import path from "node:path";

const REPO = "Xenova/all-MiniLM-L6-v2";
const BASE = `https://huggingface.co/${REPO}/resolve/main`;
const DEST = path.resolve(process.cwd(), "models", REPO);

const FILES = [
  { name: "config.json", sha256: null },
  { name: "tokenizer.json", sha256: null },
  { name: "tokenizer_config.json", sha256: null },
  { name: "special_tokens_map.json", sha256: null },
  { name: "onnx/model_quantized.onnx", sha256: null },
] as const;

const LICENSE = `Xenova/all-MiniLM-L6-v2
Derived from sentence-transformers/all-MiniLM-L6-v2 (Apache License 2.0).

Apache License 2.0
Licensed under the Apache License, Version 2.0 (the "License"); you may not
use these files except in compliance with the License. You may obtain a copy
of the License at http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS, WITHOUT
WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the
License for the specific language governing permissions and limitations under
the License.
`;

const exists = (p: string) =>
  access(p).then(
    () => true,
    () => false,
  );

async function download(file: string) {
  const dest = path.join(DEST, file);
  await mkdir(path.dirname(dest), { recursive: true });

  const res = await fetch(`${BASE}/${file}`, {
    headers: { "User-Agent": "docsearch-model-fetch/1.0" },
  });
  if (!res.ok) {
    throw new Error(`GET ${file} failed: ${res.status} ${res.statusText}`);
  }

  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(dest, buf);

  const digest = createHash("sha256").update(buf).digest("hex");
  return { file, bytes: buf.byteLength, sha256: digest };
}

async function main() {
  const force = process.argv.includes("--force");

  if (!(await exists(DEST)) || force) {
    await mkdir(DEST, { recursive: true });
  }
  await writeFile(path.join(DEST, "LICENSE.txt"), LICENSE, "utf8");

  const results = [];
  for (const { name } of FILES) {
    const dest = path.join(DEST, name);
    if (!force && (await exists(dest))) {
      const { size } = await import("node:fs/promises").then((fs) => fs.stat(dest));
      console.log(`  skip   ${name} (${(size / 1024).toFixed(0)} KB, already present)`);
      results.push({ file: name, bytes: size, cached: true });
      continue;
    }

    process.stdout.write(`  fetch  ${name} ... `);
    const r = await download(name);
    console.log(`${(r.bytes / 1024).toFixed(0)} KB`);
    results.push({ ...r, cached: false });
  }

  await writeFile(
    path.join(DEST, "MANIFEST.json"),
    JSON.stringify(
      {
        repo: REPO,
        license: "Apache-2.0",
        dtype: "q8 (int8 ONNX)",
        dimensions: 384,
        maxTokens: 256,
        files: results.map((r) => ({
          file: r.file,
          bytes: r.bytes,
          sha256: "sha256" in r && r.sha256 ? r.sha256 : null,
        })),
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  const total = results.reduce((n, r) => n + r.bytes, 0);
  console.log(`\nModel ready at ${path.relative(process.cwd(), DEST)}`);
  console.log(`Total size: ${(total / 1024 / 1024).toFixed(1)} MB`);
}

main().catch((err) => {
  console.error(`\nFailed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
