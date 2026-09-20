#!/usr/bin/env node

import { spawn } from "node:child_process";

import { loadConfig } from "./config.js";
import { startProxy } from "./server.js";
import { ExchangeStore } from "./store.js";

async function main(): Promise<void> {
  const command = process.argv[2] ?? "start";
  const config = loadConfig();

  switch (command) {
    case "start": {
      const proxy = await startProxy(config);
      process.stdout.write(`Jev Proxy listening at ${proxy.url.toString()}\n`);
      process.stdout.write(`Dashboard: ${proxy.url.toString()}\n`);
      process.stdout.write(`Database: ${config.databasePath}\n`);

      const shutdown = async (): Promise<void> => {
        await proxy.close();
        process.exitCode = 0;
      };
      process.once("SIGINT", () => void shutdown());
      process.once("SIGTERM", () => void shutdown());
      return;
    }

    case "open": {
      const url = `http://${config.host}:${config.port}`;
      const child = spawn("open", [url], { detached: true, stdio: "ignore" });
      child.unref();
      return;
    }

    case "list": {
      withStore(config.databasePath, (store) => {
        for (const exchange of store.listExchanges(50)) {
          process.stdout.write([
            exchange.startedAt,
            exchange.outcome.padEnd(14),
            String(exchange.httpStatus ?? "-").padEnd(3),
            String(exchange.inputTokens ?? "-").padStart(6),
            exchange.resolvedModel ?? exchange.requestedModel ?? "unknown-model",
            exchange.id,
          ].join("  ") + "\n");
        }
      });
      return;
    }

    case "show": {
      const id = process.argv[3];
      if (id === undefined) {
        throw new Error("Usage: jev-proxy show <exchange-id>");
      }
      withStore(config.databasePath, (store) => {
        const exchange = store.getExchange(id);
        if (exchange === null) {
          throw new Error(`Exchange not found: ${id}`);
        }
        process.stdout.write(`${JSON.stringify(exchange, null, 2)}\n`);
      });
      return;
    }

    case "export": {
      withStore(config.databasePath, (store) => {
        for (const exchange of store.exportExchanges()) {
          process.stdout.write(`${JSON.stringify(exchange)}\n`);
        }
      });
      return;
    }

    case "help":
    case "--help":
    case "-h":
      printHelp();
      return;

    default:
      throw new Error(`Unknown command: ${command}. Run jev-proxy help.`);
  }
}

function withStore(databasePath: string, operation: (store: ExchangeStore) => void): void {
  const store = new ExchangeStore(databasePath);
  try {
    operation(store);
  } finally {
    store.close();
  }
}

function printHelp(): void {
  process.stdout.write(`jev-proxy — local observability for TypeSafe Jev

Commands:
  start       Start the proxy and dashboard (default)
  open        Open the dashboard in the default browser
  list        List recent exchanges
  show <id>   Print one complete exchange as JSON
  export      Write all exchanges as JSON Lines
  help        Show this help

Environment:
  TYPESAFE_API_KEY        Upstream key; overrides incoming Authorization
  JEV_PROXY_HOST          Loopback host (default: 127.0.0.1)
  JEV_PROXY_PORT          Port (default: 7788)
  JEV_PROXY_DATABASE      SQLite path (default: ~/.jev-proxy/jev-proxy.sqlite)
  JEV_PROXY_UPSTREAM_URL  Upstream API root (default: https://api.typesafe.ai)
`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`jev-proxy: ${message}\n`);
  process.exitCode = 1;
});
