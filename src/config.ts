import { homedir } from "node:os";
import { join } from "node:path";

export type Config = {
  readonly host: string;
  readonly port: number;
  readonly databasePath: string;
  readonly upstreamBaseUrl: URL;
  readonly apiKey: string | null;
};

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): Config {
  return {
    host: readLocalHost(environment.JEV_PROXY_HOST),
    port: readPort(environment.JEV_PROXY_PORT),
    databasePath:
      environment.JEV_PROXY_DATABASE ??
      join(homedir(), ".jev-proxy", "jev-proxy.sqlite"),
    upstreamBaseUrl: readUpstreamUrl(environment.JEV_PROXY_UPSTREAM_URL),
    apiKey: readOptionalSecret(environment.TYPESAFE_API_KEY),
  };
}

function readLocalHost(value: string | undefined): string {
  const host = value?.trim() || "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    throw new Error(
      "JEV_PROXY_HOST must be a loopback address. This tool stores cleartext payloads.",
    );
  }
  return host;
}

function readPort(value: string | undefined): number {
  if (value === undefined) {
    return 7788;
  }

  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("JEV_PROXY_PORT must be an integer between 1 and 65535");
  }
  return port;
}

function readUpstreamUrl(value: string | undefined): URL {
  const url = new URL(value ?? "https://api.typesafe.ai");
  if (url.protocol !== "https:" && url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
    throw new Error("JEV_PROXY_UPSTREAM_URL must use HTTPS unless it targets localhost");
  }
  return url;
}

function readOptionalSecret(value: string | undefined): string | null {
  const secret = value?.trim();
  return secret === undefined || secret === "" ? null : secret;
}
