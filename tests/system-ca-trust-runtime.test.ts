// @vitest-environment node
import { execFile, execFileSync, spawnSync } from "child_process";
import { promisify } from "util";
import { createRequire } from "module";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import https from "https";
import type { AddressInfo } from "net";
import { build } from "esbuild";
import { expect, it } from "vitest";

const exec = promisify(execFile);
const project = resolve(import.meta.dirname, "..");
// Portable unit tests remain active when the certificate-generation tool is absent.
const hasOpenSSL =
  spawnSync("openssl", ["version"], { stdio: "ignore" }).status === 0;

function certificate(
  home: string,
  name: string,
): { root: string; key: string; cert: string } {
  const rootKey = join(home, `${name}-root.key`);
  const root = join(home, `${name}-root.pem`);
  const key = join(home, `${name}-leaf.key`);
  const request = join(home, `${name}-leaf.csr`);
  const cert = join(home, `${name}-leaf.pem`);
  const extensions = join(home, `${name}-extensions.cnf`);
  writeFileSync(
    extensions,
    "basicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:127.0.0.1\n",
  );
  const openssl = (args: string[]): void => {
    execFileSync("openssl", args, { stdio: "ignore" });
  };
  openssl([
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-sha256",
    "-days",
    "1",
    "-subj",
    `/CN=Hermes-${name}-fixture-root`,
    "-keyout",
    rootKey,
    "-out",
    root,
  ]);
  openssl([
    "req",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-sha256",
    "-subj",
    "/CN=127.0.0.1",
    "-keyout",
    key,
    "-out",
    request,
  ]);
  openssl([
    "x509",
    "-req",
    "-in",
    request,
    "-CA",
    root,
    "-CAkey",
    rootKey,
    "-CAcreateserial",
    "-out",
    cert,
    "-days",
    "1",
    "-sha256",
    "-extfile",
    extensions,
  ]);
  return { root, key, cert };
}

// @lat: [[remote-dashboard-oauth#Test specifications#Real TLS requests honor selected system trust]]
it.skipIf(!hasOpenSSL)(
  "initializes real Electron TLS trust before shared/onboarding requests while rejecting unrelated roots and hostnames",
  async () => {
    const home = mkdtempSync(join(tmpdir(), "hermes-tls-trust-"));
    const servers: https.Server[] = [];
    try {
      const trusted = certificate(home, "system");
      const extra = certificate(home, "extra");
      const unrelated = certificate(home, "unrelated");
      const received: Array<{
        path: string;
        authorization?: string;
        token?: string;
      }> = [];
      async function serve(identity: typeof trusted): Promise<string> {
        const server = https.createServer(
          {
            key: readFileSync(identity.key),
            cert: readFileSync(identity.cert),
          },
          (request, response) => {
            received.push({
              path: request.url || "",
              authorization: request.headers.authorization,
              token: String(request.headers["x-hermes-session-token"] || ""),
            });
            response.setHeader("Content-Type", "application/json");
            response.end(
              JSON.stringify({
                auth_required: false,
                version: "fixture",
                models: ["fixture-model"],
              }),
            );
          },
        );
        servers.push(server);
        await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
        return `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
      }
      const urls = {
        trusted: await serve(trusted),
        extra: await serve(extra),
        unrelated: await serve(unrelated),
      };
      const entry = join(home, "entry.cjs");
      const bundled = join(home, "fixture.cjs");
      writeFileSync(
        entry,
        `
      const tls = require('node:tls');
      const {readFileSync} = require('node:fs');
      const nativeGet = tls.getCACertificates;
      if (typeof nativeGet !== 'function' || typeof tls.setDefaultCACertificates !== 'function') throw new Error('Installed Electron lacks supported trust APIs');
      const defaults = nativeGet('default');
      const systemRoot = readFileSync(process.env.FIXTURE_ROOT, 'utf8');
      tls.getCACertificates = (type) => type === 'system' ? [systemRoot] : nativeGet(type);
      globalThis.fixtureDefaultCerts = defaults;
      require(${JSON.stringify(join(project, "src/main/index.ts"))});
      globalThis.fixtureNetworkResult.then(result => {
        process.stdout.write('HERMES_TLS_FIXTURE:' + JSON.stringify({...result, node:process.versions.node, electron:process.versions.electron}) + '\\n', () => process.exit(0));
      }).catch(error => { console.error(error.message); process.exit(1); });
    `,
      );
      const consumer = `
      import tls from 'node:tls';
      import {X509Certificate} from 'node:crypto';
      import https from 'node:https';
      import {readFileSync} from 'node:fs';
      import {remoteGetHermesVersion} from ${JSON.stringify(join(project, "src/main/remote-metadata.ts"))};
      import {remoteRequestJson} from ${JSON.stringify(join(project, "src/main/remote-sessions.ts"))};
      import {probeRemoteAuthMode} from ${JSON.stringify(join(project, "src/main/remote-oauth.ts"))};
      const systemRoot = readFileSync(process.env.FIXTURE_ROOT, 'utf8');
      const fingerprint = cert => new X509Certificate(cert).fingerprint256;
      const trustedRoots = new Set(tls.getCACertificates('default').map(fingerprint));
      const trustedAtConsumerImport = trustedRoots.has(fingerprint(systemRoot));
      const urls = JSON.parse(process.env.FIXTURE_URLS);
      async function outcome(operation) {
        try {return {ok:true, value:await operation()};}
        catch(error) {return {ok:false, code:error.code || error.cause?.code || '', message:error.message};}
      }
      function plain(url, servername) {
        return new Promise((resolve,reject) => {
          const request = https.get(url,{servername},response => {response.resume();response.on('end',()=>resolve(response.statusCode));});
          request.setTimeout(5000,()=>request.destroy(new Error('fixture timeout')));
          request.on('error',reject);
        });
      }
      export function startMainProcess() {
        globalThis.fixtureNetworkResult = (async() => {
          const proxy = urls.trusted.replace('https://','https://proxy:p%40ss@');
          const config = {remoteUrl:proxy,apiKey:'fixture-token',profile:'work'};
          return {
            trustedAtConsumerImport,
            originalDefaultsRetained: globalThis.fixtureDefaultCerts.every(cert=>trustedRoots.has(fingerprint(cert))),
            bundledRetained:tls.getCACertificates('bundled').every(cert=>trustedRoots.has(fingerprint(cert))),
            extraCount:tls.getCACertificates('extra').length,
            metadata:await outcome(()=>remoteGetHermesVersion(config)),
            shared:await outcome(()=>remoteRequestJson(config,'/api/models')),
            probe:await outcome(()=>probeRemoteAuthMode(proxy)),
            extra:await outcome(()=>plain(urls.extra)),
            unrelated:await outcome(()=>plain(urls.unrelated)),
            wrongHostname:await outcome(()=>plain(urls.trusted,'unrelated.invalid')),
          };
        })();
      }
    `;
      await build({
        entryPoints: [entry],
        outfile: bundled,
        bundle: true,
        platform: "node",
        format: "cjs",
        packages: "external",
        logLevel: "silent",
        plugins: [
          {
            name: "isolated-main-entry",
            setup(api) {
              api.onResolve({ filter: /^\.\/app\/start$/ }, () => ({
                path: "consumer",
                namespace: "fixture",
              }));
              api.onResolve(
                { filter: /^\.\/(gpu-fallback|load-env)$/ },
                () => ({
                  path: "non-network-ui",
                  namespace: "fixture",
                }),
              );
              api.onResolve({ filter: /^electron$/ }, () => ({
                path: "electron",
                namespace: "fixture",
              }));
              api.onLoad(
                { filter: /^consumer$/, namespace: "fixture" },
                () => ({
                  contents: consumer,
                  resolveDir: project,
                }),
              );
              api.onLoad(
                { filter: /^non-network-ui$/, namespace: "fixture" },
                () => ({
                  contents:
                    "export const applyGpuPreferences=()=>{};export const installGpuCrashGuard=()=>{};export const loadDotEnvForDev=()=>{};",
                }),
              );
              api.onLoad(
                { filter: /^electron$/, namespace: "fixture" },
                () => ({
                  contents:
                    "export const app={isPackaged:true,commandLine:{appendSwitch(){}}};export const BrowserWindow=class {};export const session={};export const net={};export const shell={};export const dialog={};export const ipcMain={};",
                }),
              );
            },
          },
        ],
      });
      const electron = createRequire(join(project, "package.json"))(
        "electron",
      ) as string;
      expect(existsSync(electron)).toBe(true);
      const env = {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        NODE_OPTIONS: "",
        NODE_PATH: join(project, "node_modules"),
        NODE_EXTRA_CA_CERTS: extra.root,
        NODE_TLS_REJECT_UNAUTHORIZED: "1",
        HOME: home,
        HERMES_HOME: join(home, "hermes"),
        HERMES_DESKTOP_USER_DATA_DIR: join(home, "userdata"),
        FIXTURE_ROOT: trusted.root,
        FIXTURE_URLS: JSON.stringify(urls),
      };
      const { stdout } = await exec(electron, [bundled], {
        cwd: home,
        env,
        timeout: 25000,
      });
      const resultLine = stdout
        .split("\n")
        .find((line) => line.startsWith("HERMES_TLS_FIXTURE:"));
      expect(resultLine).toBeDefined();
      const result = JSON.parse(
        resultLine!.slice("HERMES_TLS_FIXTURE:".length),
      );
      expect(result.trustedAtConsumerImport, JSON.stringify(result)).toBe(true);
      expect(result.originalDefaultsRetained).toBe(true);
      expect(result.bundledRetained).toBe(true);
      expect(result.extraCount).toBeGreaterThan(0);
      expect(result.metadata).toMatchObject({
        ok: true,
        value: "Hermes Agent vfixture",
      });
      expect(result.shared).toMatchObject({
        ok: true,
        value: { models: ["fixture-model"] },
      });
      expect(result.probe).toMatchObject({
        ok: true,
        value: { authMode: "token" },
      });
      expect(result.extra).toMatchObject({ ok: true, value: 200 });
      expect(result.unrelated.ok).toBe(false);
      expect(result.unrelated.code).toMatch(
        /SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT_LOCALLY/,
      );
      expect(result.wrongHostname).toMatchObject({
        ok: false,
        code: "ERR_TLS_CERT_ALTNAME_INVALID",
      });
      const basic = `Basic ${Buffer.from("proxy:p@ss").toString("base64")}`;
      expect(received).toContainEqual({
        path: "/api/status?profile=work",
        authorization: basic,
        token: "fixture-token",
      });
      expect(received).toContainEqual({
        path: "/api/models?profile=work",
        authorization: basic,
        token: "fixture-token",
      });
      expect(received).toContainEqual({
        path: "/api/status",
        authorization: basic,
        token: "",
      });
    } finally {
      for (const server of servers) {
        server.closeAllConnections();
        await new Promise<void>((done) => server.close(() => done()));
      }
      rmSync(home, { recursive: true, force: true });
    }
  },
  40000,
);
