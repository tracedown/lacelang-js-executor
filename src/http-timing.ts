/**
 * HTTP client with per-phase timing (dns / connect / tls / ttfb / transfer).
 *
 * Uses Node.js http/https modules directly to measure each phase separately.
 * Resolution is the OS clock — accurate to microseconds on modern platforms —
 * but reported values are milliseconds (spec §9.2).
 *
 * The client returns raw response data without auto-decoding, so the caller
 * controls body storage. It does NOT follow redirects itself; callers that
 * opt into redirect following issue a new request per hop and accumulate
 * timings.
 */

import * as http from "node:http";
import * as https from "node:https";
import * as net from "node:net";
import * as tls from "node:tls";
import * as dns from "node:dns";
import { performance } from "node:perf_hooks";

// ─── Data structures ──────────────────────────────────────────────────

export interface Timings {
  dnsMs: number;
  connectMs: number;
  tlsMs: number;
  ttfbMs: number;
  transferMs: number;
  responseTimeMs: number;
}

export interface DnsMeta {
  resolvedIps: string[];
  resolvedIp: string | null;
}

export interface TlsMeta {
  protocol: string;
  cipher: string;
  alpn: string | null;
  certificate: Record<string, unknown> | null;
}

export interface HttpResponse {
  status: number;
  statusText: string;
  headers: Record<string, string | string[]>;
  body: Buffer;
  timings: Timings;
  finalUrl: string;
  dns: DnsMeta;
  tls: TlsMeta | null;
}

export interface HttpResult {
  response: HttpResponse | null;
  error: string | null;
  timedOut: boolean;
  timings: Timings;
}

// ─── Helpers ──────────────────────────────────────────────────────────

function ms(seconds: number): number {
  return Math.max(0, Math.round(seconds * 1000));
}

function msPerfDelta(start: number, end: number): number {
  return Math.max(0, Math.round(end - start));
}

function uniquePreserve(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const it of items) {
    if (!seen.has(it)) {
      seen.add(it);
      out.push(it);
    }
  }
  return out;
}

function formatCertificate(cert: tls.PeerCertificate): Record<string, unknown> {
  const subjectCn = cert.subject?.CN || null;
  const issuerCn = cert.issuer?.CN || null;

  const san: string[] = [];
  if (cert.subjectaltname) {
    for (const entry of cert.subjectaltname.split(", ")) {
      san.push(entry);
    }
  }

  return {
    subject: { cn: subjectCn },
    subjectAltNames: san,
    issuer: { cn: issuerCn },
    notBefore: cert.valid_from || "",
    notAfter: cert.valid_to || "",
  };
}

// ─── TLS probe ────────────────────────────────────────────────────────

export function probeTlsVerify(url: string, timeoutS: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") {
      resolve();
      return;
    }
    const host = parsed.hostname;
    const port = parsed.port ? parseInt(parsed.port, 10) : 443;

    const socket = tls.connect(
      {
        host,
        port,
        servername: host,
        timeout: timeoutS * 1000,
        rejectUnauthorized: true,
      },
      () => {
        socket.destroy();
        resolve();
      },
    );
    socket.on("error", (err) => {
      socket.destroy();
      reject(err);
    });
    socket.on("timeout", () => {
      socket.destroy();
      resolve();
    });
  });
}

// ─── Main request function ────────────────────────────────────────────

export function sendRequest(
  method: string,
  url: string,
  headers: Record<string, string>,
  body: Buffer | null,
  timeoutS: number,
  verifyTls: boolean = true,
): Promise<HttpResult> {
  return new Promise<HttpResult>((resolve) => {
    const timings: Timings = {
      dnsMs: 0,
      connectMs: 0,
      tlsMs: 0,
      ttfbMs: 0,
      transferMs: 0,
      responseTimeMs: 0,
    };

    const dnsMeta: DnsMeta = { resolvedIps: [], resolvedIp: null };
    let tlsMeta: TlsMeta | null = null;

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      resolve({ response: null, error: `invalid URL: ${url}`, timedOut: false, timings });
      return;
    }

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      resolve({
        response: null,
        error: `unsupported scheme: '${parsed.protocol.replace(":", "")}'`,
        timedOut: false,
        timings,
      });
      return;
    }

    const isHttps = parsed.protocol === "https:";
    const hostname = parsed.hostname;
    const port = parsed.port
      ? parseInt(parsed.port, 10)
      : isHttps
        ? 443
        : 80;
    const path = (parsed.pathname || "/") + (parsed.search || "");

    // If hostname is already an IP address, Node skips the lookup function
    // entirely. Pre-populate DNS metadata so it's never empty.
    const IP_RE = /^(\d{1,3}\.){3}\d{1,3}$|^\[?[0-9a-fA-F:]+\]?$/;
    if (IP_RE.test(hostname)) {
      const bare = hostname.replace(/^\[|\]$/g, "");
      dnsMeta.resolvedIp = bare;
      dnsMeta.resolvedIps = [bare];
    }

    const tStart = performance.now();
    let tDnsStart = tStart;
    let tConnectStart = tStart;
    let tTlsStart = tStart;
    let tReqSent = tStart;

    const options: http.RequestOptions = {
      hostname,
      port,
      path,
      method,
      headers,
      timeout: timeoutS * 1000,
    };

    if (isHttps) {
      (options as https.RequestOptions).rejectUnauthorized = verifyTls;
      // Advertise only http/1.1 — Node's http module cannot speak HTTP/2.
      (options as Record<string, unknown>).ALPNProtocols = ["http/1.1"];
    }

    // Custom DNS lookup to measure DNS time.
    // Node's http module passes { hints, all: true } and expects array results.
    // We forward the call to dns.lookup with the same options Node provided,
    // but capture timing and metadata along the way.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    options.lookup = ((host: string, opts: any, cb: any) => {
      tDnsStart = performance.now();
      const callback = typeof opts === "function" ? opts : cb;
      const lookupOpts = typeof opts === "function" ? {} : opts;

      dns.lookup(host, lookupOpts, (err: NodeJS.ErrnoException | null, addressResult: unknown, familyResult: unknown) => {
        const tDnsEnd = performance.now();
        timings.dnsMs = msPerfDelta(tDnsStart, tDnsEnd);

        if (!err) {
          if (Array.isArray(addressResult)) {
            // all: true — array of { address, family }
            dnsMeta.resolvedIps = addressResult.map((a: { address: string }) => a.address);
            dnsMeta.resolvedIp = addressResult.length > 0 ? addressResult[0].address : null;
          } else if (typeof addressResult === "string") {
            dnsMeta.resolvedIp = addressResult;
            dnsMeta.resolvedIps = [addressResult];
          }
        }

        callback(err, addressResult, familyResult);
      });
    }) as http.RequestOptions["lookup"];

    const requestFn = isHttps ? https.request : http.request;
    let timedOut = false;
    let resolved = false;

    const req = requestFn(options, (resp) => {
      const tTtfb = performance.now();
      // Connect + TLS timing from socket events (if available)
      timings.ttfbMs = msPerfDelta(tReqSent, tTtfb) + timings.dnsMs + timings.connectMs + timings.tlsMs;

      const chunks: Buffer[] = [];
      resp.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
      });

      resp.on("end", () => {
        if (resolved) return;
        resolved = true;

        const tDone = performance.now();
        timings.transferMs = msPerfDelta(tTtfb, tDone);
        timings.responseTimeMs = msPerfDelta(tStart, tDone);

        const rawBody = Buffer.concat(chunks);

        // Collect headers; preserve multi-value lists per spec §9.2.
        const collected: Record<string, string | string[]> = {};
        const rawHeaders = resp.rawHeaders;
        for (let i = 0; i < rawHeaders.length; i += 2) {
          const k = rawHeaders[i].toLowerCase();
          const v = rawHeaders[i + 1];
          if (k in collected) {
            const existing = collected[k];
            if (Array.isArray(existing)) {
              existing.push(v);
            } else {
              collected[k] = [existing, v];
            }
          } else {
            collected[k] = v;
          }
        }

        resolve({
          response: {
            status: resp.statusCode || 0,
            statusText: resp.statusMessage || "",
            headers: collected,
            body: rawBody,
            timings,
            finalUrl: url,
            dns: dnsMeta,
            tls: tlsMeta,
          },
          error: null,
          timedOut: false,
          timings,
        });
      });
    });

    req.on("socket", (socket) => {
      tConnectStart = performance.now();

      socket.on("connect", () => {
        const tConnected = performance.now();
        timings.connectMs = msPerfDelta(tConnectStart, tConnected);
        tTlsStart = tConnected;
      });

      if (isHttps) {
        const captureTls = () => {
          const tlsSocket = socket as tls.TLSSocket;
          const cipher = tlsSocket.getCipher?.();
          const cert = tlsSocket.getPeerCertificate?.();
          const protocol = tlsSocket.getProtocol?.() || "";
          const alpn = tlsSocket.alpnProtocol || null;

          let certificate: Record<string, unknown> | null = null;
          if (cert && Object.keys(cert).length > 0 && cert.subject) {
            certificate = formatCertificate(cert);
          }

          tlsMeta = {
            protocol,
            cipher: cipher?.name || "",
            alpn: alpn === "false" ? null : alpn,
            certificate,
          };
        };

        socket.on("secureConnect", () => {
          const tSecure = performance.now();
          timings.tlsMs = msPerfDelta(tTlsStart, tSecure);
          captureTls();
        });

        // On reused keep-alive sockets, secureConnect doesn't fire again.
        // Capture TLS metadata from the already-connected socket.
        if ((socket as tls.TLSSocket).encrypted && (socket as tls.TLSSocket).authorized !== undefined) {
          captureTls();
        }
      }
    });

    req.on("timeout", () => {
      timedOut = true;
      req.destroy();
    });

    req.on("error", (err) => {
      if (resolved) return;
      resolved = true;

      if (timedOut) {
        resolve({
          response: null,
          error: "request timed out",
          timedOut: true,
          timings,
        });
      } else {
        resolve({
          response: null,
          error: String(err.message || err),
          timedOut: false,
          timings,
        });
      }
    });

    // Send request body and mark time
    if (body && body.length > 0) {
      req.write(body);
    }
    req.end();
    tReqSent = performance.now();
  });
}
