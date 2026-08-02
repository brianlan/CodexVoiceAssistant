import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import path from "node:path";

export type CertificatePaths = {
  cert: string;
  key: string;
  ca: string;
};

export function ensureCertificates(certDir: string, hostIp: string): CertificatePaths {
  mkdirSync(certDir, { recursive: true, mode: 0o700 });
  const caKey = path.join(certDir, "ca.key");
  const ca = path.join(certDir, "ca.crt");
  const key = path.join(certDir, "server.key");
  const cert = path.join(certDir, "server.crt");
  const marker = path.join(certDir, "server.host");

  if (!existsSync(caKey) || !existsSync(ca)) {
    run("openssl", [
      "req", "-x509", "-newkey", "rsa:3072", "-sha256", "-days", "3650", "-nodes",
      "-subj", "/CN=Codex Voice Local CA/O=Codex Voice",
      "-keyout", caKey, "-out", ca,
    ]);
  }

  const needsServerCertificate =
    !existsSync(key) || !existsSync(cert) || !existsSync(marker) || readFileSync(marker, "utf8") !== hostIp;

  if (needsServerCertificate) {
    const csr = path.join(certDir, "server.csr");
    const extensions = path.join(certDir, "server.ext");
    const san = isIP(hostIp) ? `IP:${hostIp}` : `DNS:${hostIp}`;
    writeFileSync(
      extensions,
      [
        "authorityKeyIdentifier=keyid,issuer",
        "basicConstraints=CA:FALSE",
        "keyUsage=digitalSignature,keyEncipherment",
        "extendedKeyUsage=serverAuth",
        `subjectAltName=DNS:localhost,IP:127.0.0.1,${san}`,
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    run("openssl", [
      "req", "-newkey", "rsa:3072", "-nodes", "-subj", `/CN=${hostIp}`,
      "-keyout", key, "-out", csr,
    ]);
    run("openssl", [
      "x509", "-req", "-sha256", "-days", "825", "-in", csr,
      "-CA", ca, "-CAkey", caKey, "-CAcreateserial", "-out", cert,
      "-extfile", extensions,
    ]);
    writeFileSync(marker, hostIp, { mode: 0o600 });
  }

  return { cert, key, ca };
}

export function readTlsOptions(paths: CertificatePaths) {
  return {
    cert: readFileSync(paths.cert),
    key: readFileSync(paths.key),
  };
}

function run(command: string, args: string[]): void {
  execFileSync(command, args, { stdio: "ignore" });
}
