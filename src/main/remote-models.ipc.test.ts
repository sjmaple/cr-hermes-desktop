// @vitest-environment node
import http from "node:http";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { afterEach, expect, it, vi } from "vitest";
import type { ConnectionConfig } from "./config";
import { remoteListModels } from "./remote-models";

function handler(
  channel: string,
  dependencies: Record<string, unknown>,
): (...args: unknown[]) => unknown {
  const source = readFileSync(
    resolve(process.cwd(), "src/main/ipc/register.ts"),
    "utf8",
  );
  const ast = ts.createSourceFile(
    "register.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  let expression: ts.Node | undefined;
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(ast) === "ipcMain.handle" &&
      ts.isStringLiteral(node.arguments[0]) &&
      node.arguments[0].text === channel
    ) {
      expression = node.arguments[1];
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  if (!expression) throw new Error(`Missing IPC ${channel}`);
  const js = ts.transpileModule(
    `const selected = ${expression.getText(ast)};`,
    {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    },
  ).outputText;
  return new Function(
    ...Object.keys(dependencies),
    `${js}; return (...args) => selected({}, ...args);`,
  )(...Object.values(dependencies));
}

const servers: http.Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((done, fail) =>
      server.close((error) => (error ? fail(error) : done())),
    );
  }
});

async function gateway(
  mode: "ok" | "unauthorized" | "missing" | "html" = "ok",
): Promise<{
  connection: ConnectionConfig;
  requests: Array<{
    method: string;
    path: string;
    authorization?: string;
    token?: string;
  }>;
}> {
  const requests: Array<{
    method: string;
    path: string;
    authorization?: string;
    token?: string;
  }> = [];
  const server = http.createServer((request, response) => {
    requests.push({
      method: request.method || "",
      path: request.url || "",
      authorization: request.headers.authorization,
      token: request.headers["x-hermes-session-token"] as string | undefined,
    });
    // Match the actual raw Agent route contract: /api/model/library is absent;
    // /api/model/options is an authenticated GET and returns picker inventory.
    if (request.url !== "/api/model/options") {
      response.writeHead(404).end("missing");
      return;
    }
    if (
      mode === "unauthorized" ||
      request.headers.authorization !== "Bearer fixture-key-for-models"
    ) {
      response
        .writeHead(401, { "Content-Type": "application/json" })
        .end(JSON.stringify({ error: { message: "Invalid API key" } }));
      return;
    }
    if (mode === "missing") {
      response.writeHead(404).end("missing");
      return;
    }
    if (mode === "html") {
      response
        .writeHead(200, { "Content-Type": "text/html" })
        .end("<html>proxy login</html>");
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json" }).end(
      JSON.stringify({
        provider: "openai",
        model: "gateway-model",
        providers: [
          {
            slug: "openai",
            name: "Gateway provider",
            authenticated: true,
            is_current: true,
            api_url: "https://models.test/v1",
            models: ["gateway-model", "other-model"],
          },
        ],
      }),
    );
  });
  await new Promise<void>((done, fail) => {
    server.once("error", fail);
    server.listen(0, "127.0.0.1", done);
  });
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing gateway address");
  return {
    connection: {
      mode: "remote",
      remoteUrl: `http://127.0.0.1:${address.port}`,
      apiKey: "fixture-key-for-models",
      remoteAuthMode: "token",
      remoteChatTransport: "legacy",
    } as ConnectionConfig,
    requests,
  };
}

function modelReader(connection: ConnectionConfig): {
  read: () => unknown;
  local: ReturnType<typeof vi.fn>;
} {
  const local = vi.fn(() => {
    throw new Error("Local model/config access forbidden");
  });
  const read = handler("list-models", {
    getConnectionConfig: () => connection,
    getActiveConnection: () => ({ connectionId: "remote-fixture" }),
    getRemoteSelectedProfile: () => "default",
    remoteListModels,
    listModels: local,
    sshListModels: local,
    withSshDashboardModelLibrary: local,
    getActiveProfileNameSync: local,
  });
  return { read, local };
}

// @lat: [[model-selection#Remote picker catalog#Legacy gateway read-only inventory]]
it("actual Legacy Remote list-models IPC reads the authenticated raw gateway catalog through the real HTTP adapter", async () => {
  const fixture = await gateway();
  const { read, local } = modelReader(fixture.connection);
  await expect(Promise.resolve().then(read)).resolves.toEqual([
    expect.objectContaining({
      provider: "openai",
      model: "gateway-model",
      baseUrl: "https://models.test/v1",
    }),
    expect.objectContaining({
      provider: "openai",
      model: "other-model",
      baseUrl: "https://models.test/v1",
    }),
  ]);
  expect(
    fixture.requests.map(({ method, path }) => ({ method, path })),
  ).toEqual([
    { method: "GET", path: "/api/model/library" },
    { method: "GET", path: "/api/model/options" },
  ]);
  expect(
    fixture.requests.every(
      (request) =>
        request.authorization === "Bearer fixture-key-for-models" &&
        request.token === "fixture-key-for-models",
    ),
  ).toBe(true);
  expect(local).not.toHaveBeenCalled();
});

// @lat: [[model-selection#Remote picker catalog#Named Legacy selection is not a default catalog]]
it("refuses a named Legacy selection before it can read the gateway's default catalog", async () => {
  const fixture = await gateway();
  const remote = vi.fn(remoteListModels);
  const selected = vi.fn(() => "work");
  const read = handler("list-models", {
    getConnectionConfig: () => fixture.connection,
    getActiveConnection: () => ({ connectionId: "remote-fixture" }),
    getRemoteSelectedProfile: selected,
    remoteListModels: remote,
  });
  await expect(async () => read()).rejects.toThrow(
    "Named Remote Legacy model library reads require dashboard transport",
  );
  expect(selected).toHaveBeenCalledWith("remote-fixture", fixture.connection);
  expect(remote).not.toHaveBeenCalled();
  expect(fixture.requests).toHaveLength(0);
});

// @lat: [[model-selection#Remote picker catalog#Legacy inventory failure stays remote]]
it.each(["unauthorized", "missing", "html"] as const)(
  "actual Legacy inventory %s failure never reads a local catalog",
  async (mode) => {
    const fixture = await gateway(mode);
    const { read, local } = modelReader(fixture.connection);
    await expect(async () => read()).rejects.toThrow(
      mode === "unauthorized" ? /401/ : mode === "missing" ? /404/ : /JSON/,
    );
    expect(fixture.requests).toHaveLength(2);
    expect(local).not.toHaveBeenCalled();
  },
);

// @lat: [[model-selection#Remote picker catalog#Legacy model mutations stay refused]]
it("actual Legacy Remote model-library mutation IPC remains refused", async () => {
  const fixture = await gateway();
  const mutation = vi.fn();
  const dependencies = {
    getConnectionConfig: () => fixture.connection,
    remoteAddModel: mutation,
    remoteRemoveModel: mutation,
    remoteUpdateModel: mutation,
    addModel: mutation,
    removeModel: mutation,
    updateModel: mutation,
  };
  for (const [channel, args] of [
    ["add-model", ["Name", "openai", "model", ""]],
    ["remove-model", ["id"]],
    ["update-model", ["id", { name: "Name" }]],
  ] as const) {
    const write = handler(channel, dependencies);
    await expect(async () => write(...args)).rejects.toThrow(
      "Remote model library writes require dashboard transport",
    );
  }
  expect(mutation).not.toHaveBeenCalled();
  expect(fixture.requests).toHaveLength(0);
});
