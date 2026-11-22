"""Provision and exercise distinct real UIDs inside a disposable Linux guest."""
import json
import os
from pathlib import Path
import shutil
import socket
import stat
import subprocess
import sys
import tempfile
import time
import uuid

AUTHORITY, EXECUTOR, OPERATOR = 42001, 42002, 42003
CLIENTS = 42004
HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
MODULES = ("authority-service.js", "authority-client.js", "approval-evidence.js",
           "voice123-projects.js", "attachment-review.js", "clarification-log.js",
           "connectivity-local.js")
REPORT = []
ENV = {"PATH": os.defpath, "LANG": "C.UTF-8"}


def passed(label):
    REPORT.append(label)
    print(f"PASS {len(REPORT):02d} {label}", flush=True)


def check(ok, message):
    if not ok:
        raise RuntimeError(message)


def start(uid, args):
    return subprocess.Popen(args, user=uid, group=uid, extra_groups=[CLIENTS] if uid in
                            (EXECUTOR, OPERATOR) else [], umask=0o077, env=ENV,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)


def result(proc, error=None):
    try:
        out, err = proc.communicate(timeout=12)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.communicate()
        raise RuntimeError("Fixture command timed out") from None
    if error is None:
        check(proc.returncode == 0, f"Role command failed: {err.strip()}")
        return json.loads(out)
    check(proc.returncode != 0 and error in err, f"Expected denial {error!r}, got {err.strip()!r}")


def describe(file):
    info = file.stat()
    return {"path": file.name, "uid": info.st_uid, "gid": info.st_gid, "mode": oct(stat.S_IMODE(info.st_mode))}


def effective_uid(proc):
    status = Path(f"/proc/{proc.pid}/status").read_text().splitlines()
    return int(next(line for line in status if line.startswith("Uid:")).split()[2])


def await_socket(file, proc, mode=None):
    end = time.monotonic() + 5
    while time.monotonic() < end:
        check(proc.poll() is None, "Fixture listener exited")
        if file.is_socket() and (mode is None or stat.S_IMODE(file.stat().st_mode) == mode):
            return
        time.sleep(.025)
    raise RuntimeError("Fixture socket unavailable")


def main(root, node):
    root.chmod(0o755)
    state, operator, run, checkpoint, code = [root / name for name in
                                             ("state", "operator", "run", "checkpoint", "code")]
    for folder, uid, gid, mode in [(state, AUTHORITY, AUTHORITY, 0o700),
                                   (operator, OPERATOR, OPERATOR, 0o700),
                                   (run, AUTHORITY, CLIENTS, 0o2710),
                                   (checkpoint, 0, AUTHORITY, 0o750), (code, 0, 0, 0o755)]:
        folder.mkdir()
        os.chown(folder, uid, gid)
        folder.chmod(mode)
    for file in [*(REPO / module for module in MODULES), HERE / "role.cjs", HERE / "peer-gateway.py"]:
        shutil.copyfile(file, code / file.name)
        (code / file.name).chmod(0o644)

    def role(uid, action, payload=None):
        return start(uid, [node, str(code / "role.cjs"), action, str(root), json.dumps(payload)])

    authority_id = str(uuid.uuid4())
    key = result(role(OPERATOR, "keys"))
    check(key["uid"] == OPERATOR, "Unexpected signer UID")
    public_key = state / "verify.pem"
    public_key.write_text(key["value"])
    os.chown(public_key, AUTHORITY, AUTHORITY)
    public_key.chmod(0o600)
    initial = result(role(AUTHORITY, "initialize", authority_id))
    check(initial["uid"] == AUTHORITY, "Unexpected authority UID")
    head = checkpoint / "head.json"
    head.write_text(json.dumps(initial["value"]))
    os.chown(head, 0, AUTHORITY)
    head.chmod(0o640)
    journal = state / "journal.jsonl"
    service_head = state / "head.json"
    empty = (journal.read_bytes(), service_head.read_bytes())
    private_socket = state / "private.sock"
    gateway_socket = run / "gateway.sock"
    policy = state / "peers.json"

    def set_policy(executor=EXECUTOR):
        pending = policy.with_suffix(".next")
        pending.write_text(json.dumps({"executor": executor, "operator": OPERATOR}))
        os.chown(pending, AUTHORITY, AUTHORITY)
        pending.chmod(0o600)
        pending.replace(policy)

    set_policy()
    service = role(AUTHORITY, "serve", authority_id)
    gateway = None

    def stop(proc):
        if proc and proc.poll() is None:
            proc.terminate()
            try:
                proc.communicate(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.communicate()

    def send(uid, message, error=None):
        return result(role(uid, "raw", message), error)

    def signed(action, payload, error=None):
        return result(role(OPERATOR, "operator", {"authorityId": authority_id,
                      "action": action, "payload": payload}), error)

    binding = {"projectId": "SYNTH12ADISTINCT", "trackingId": "synthetic-distinct",
               "approvalSha256": "a" * 64, "clarificationSha256": "b" * 64, "audioSha256": "c" * 64}

    def grant():
        return signed("grant", {"binding": binding, "operation": "submission",
                      "reference": "offline-uid-rehearsal", "expiresAt": int(time.time() * 1000) + 180_000})["value"]

    def issue(grant_id, error=None):
        return signed("issue", {"grantId": grant_id, "expiresAt": int(time.time() * 1000) + 120_000}, error)

    try:
        await_socket(private_socket, service)
        gateway = start(AUTHORITY, [sys.executable, str(code / "peer-gateway.py"),
                        str(gateway_socket), str(private_socket), str(policy)])
        await_socket(gateway_socket, gateway, 0o660)
        metadata = [describe(file) for file in (state, journal, service_head, operator, operator / "signer.pem",
                    public_key, head, run, gateway_socket)]
        check(effective_uid(service) == effective_uid(gateway) == AUTHORITY, "Wrong service or gateway UID")
        print(json.dumps({"authority_uid": effective_uid(service), "gateway_uid": effective_uid(gateway),
                          "operator_uid": key["uid"], "metadata": metadata}))
        check(gateway_socket.stat().st_gid == CLIENTS, "Socket group does not match client group")
        permit = issue(grant())["value"]
        opened = result(role(EXECUTOR, "open", permit))
        check(opened["uid"] == EXECUTOR and opened["value"]["id"] == permit["id"], "Wrong executor identity or permit")
        validate = {"action": "validate", "permitId": permit["id"], "binding": binding}
        send(EXECUTOR, validate)
        passed("real executor UID opened and validated the signed permit through the gateway")

        probes = {"read operator private key": operator / "signer.pem", "write operator private key": operator / "signer.pem",
                  "read authority key material": public_key, "write grants and ledger": journal,
                  "delete authoritative audit": journal, "write authority head": service_head,
                  "delete authority head": service_head, "write independent checkpoint": head,
                  "delete independent checkpoint": head, "create in authority storage": state / "injected",
                  "create in socket directory": run / "spoof.sock", "delete gateway": gateway_socket}
        denied = result(role(EXECUTOR, "probe-files", {k: str(v) for k, v in probes.items()}))
        print(json.dumps(denied))
        check(denied["uid"] == EXECUTOR and all(code in ("EACCES", "EPERM") for _, code in denied["value"]),
              "An executor file probe bypassed isolation")
        passed("kernel denied all executor authority-file, key, checkpoint and socket mutations")
        direct = start(EXECUTOR, [sys.executable, "-c",
            "import socket,sys; socket.socket(socket.AF_UNIX).connect(sys.argv[1])", str(private_socket)])
        result(direct, "Permission denied")
        passed("executor could not connect directly to the private upstream")

        for action in ("issue", "revoke", "grant", "reconcile"):
            send(EXECUTOR, {"action": "operator", "uid": OPERATOR, "command": {"action": action}}, "OS peer denied")
        send(OPERATOR, {"action": "operator", "command": {"action": "issue"}}, "Invalid operator signature")
        passed("OS identity and operator signature both required for privileged requests")
        # Replay protection: the exact same signed operator command must be rejected.
        replay_payload = {
            "binding": {**binding, "trackingId": "synthetic-replay", "audioSha256": None},
            "operation": "discovery",
            "reference": "offline-replay-test",
            "expiresAt": int(time.time() * 1000) + 180_000
        }
        replay_request = result(role(OPERATOR, "sign-only", {
            "authorityId": authority_id,
            "action": "grant",
            "payload": replay_payload
        }))["value"]

        first_replay = send(OPERATOR, replay_request)
        check(first_replay["value"], "Initial signed command was not accepted")

        send(OPERATOR, replay_request, "Operator command replay blocked")
        replay_nonce = replay_request["command"]["nonce"]
        replay_records = [
            record
            for line in journal.read_text().splitlines()
            if (record := json.loads(line)).get("data", {}).get("nonce") == replay_nonce
        ]
        check(
            len(replay_records) == 1 and replay_records[0]["event"] == "grant",
            "Replay created duplicate or unexpected journal records"
        )
        passed("identical signed operator command replay rejected")
        send(EXECUTOR, {**validate, "binding": {**binding, "approvalSha256": "d" * 64}}, "evidence changed")
        passed("stale approval fingerprint rejected")

        # Preserve the exact same connected socket across the policy change.
        keepalive = r"""
import http.client, json, os, socket, sys
class Client(http.client.HTTPConnection):
    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX)
        self.sock.settimeout(5)
        self.sock.connect(sys.argv[1])
client = Client("localhost")
sock = None
for _ in range(2):
    client.request("POST", "/authorize", body=sys.argv[2])
    response = client.getresponse()
    response.read()
    if sock is None:
        sock = client.sock
    assert sock is not None and client.sock is sock
    print(json.dumps([os.getuid(), response.status]), flush=True)
    if _ == 0:
        with open(sys.argv[3]) as barrier:
            assert barrier.read() == "go"
"""
        barrier = root / "continue"
        os.mkfifo(barrier, 0o644)
        barrier.chmod(0o644)
        live = start(EXECUTOR, [sys.executable, "-c", keepalive, str(gateway_socket), json.dumps(validate), str(barrier)])
        try:
            import select
            ready, _, _ = select.select([live.stdout], [], [], 5)
            check(ready and json.loads(live.stdout.readline()) == [EXECUTOR, 200], "Keepalive initial request failed")
            set_policy(None)
            send(EXECUTOR, validate, "OS peer denied")
            run.chmod(0o2700)
            try:
                send(EXECUTOR, validate, "Authority unavailable")
            finally:
                run.chmod(0o2710)
            deadline = time.monotonic() + 5
            while True:
                try:
                    fd = os.open(barrier, os.O_WRONLY | os.O_NONBLOCK)
                    break
                except OSError:
                    check(time.monotonic() < deadline, "Keepalive barrier unavailable")
                    time.sleep(.025)
            with os.fdopen(fd, "w") as trigger:
                trigger.write("go")
            out, err = live.communicate(timeout=6)
            check(live.returncode == 0 and json.loads(out) == [EXECUTOR, 403], f"Established socket retained access: {err}")
            passed("revocation denied both new requests and the already connected client")
        finally:
            stop(live)
            set_policy()

        claims = [role(EXECUTOR, "claim", {"permit": permit, "binding": binding}) for _ in range(3)]
        results = [job.communicate(timeout=12) for job in claims]
        check(sum(job.returncode == 0 for job in claims) == 1 and
              all(job.returncode == 0 or "consumed" in output[1] for job, output in zip(claims, results)),
              "Duplicate-claim outcomes unexpected")
        claim = next(json.loads(output[0]) for job, output in zip(claims, results) if job.returncode == 0)
        check(claim["uid"] == EXECUTOR, "Wrong claimant UID")
        signed("reconcile", {"permitId": permit["id"], "attemptId": claim["value"], "outcome": "confirmed-no-action",
                            "reference": "mock verified no action".replace(" ", "-")})
        passed("exactly one of three executor processes claimed")

        later = issue(grant())["value"]
        crashed = role(EXECUTOR, "crash", {"permit": later, "binding": binding})
        crashed.communicate(timeout=12)
        check(crashed.returncode == -9, "Executor did not crash after claim")
        issue(grant(), "requires reconciliation")
        unresolved = next(record["data"] for line in reversed(journal.read_text().splitlines()) if (record := json.loads(line)).get("event") == "claim" and record["data"].get("permitId") == later["id"])
        check(unresolved["permitId"] == later["id"] and unresolved["outcome"] == "unresolved", "Expected unresolved claim")
        signed("reconcile", {"permitId": later["id"], "attemptId": unresolved["attemptId"], "outcome": "uncertain",
                             "reference": "mock-missing-confirmation"}, "verified reconciliation")
        passed("post-claim crash left an unresolved outcome and blocked replacement")

        final_head = service_head.read_text()
        head.write_text(final_head)
        stop(service)
        check(service.returncode == 0, "Authority stopped uncleanly")
        if private_socket.exists():
            private_socket.unlink()
        send(EXECUTOR, {"action": "open", "permitId": later["id"]}, "authority unavailable")
        service = role(AUTHORITY, "serve", authority_id)
        await_socket(private_socket, service)
        result(role(EXECUTOR, "open", later), "consumed")

        # Verify replay protection survives an authority restart.
        check(
            replay_request["command"]["expiresAt"] > int(time.time() * 1000),
            "Replay test command expired before restart verification"
        )
        send(OPERATOR, replay_request, "Operator command replay blocked")
        passed("authority outage, crash claim, and persisted replay protection verified")

        stop(service)
        check(service.returncode == 0, "Authority stopped uncleanly")
        missing = checkpoint / "saved.json"
        head.rename(missing)
        result(role(AUTHORITY, "serve", authority_id), "ENOENT")
        missing.rename(head)
        current = journal.read_bytes(), service_head.read_bytes()
        journal.write_bytes(empty[0])
        service_head.write_bytes(empty[1])
        result(role(AUTHORITY, "serve", authority_id), "Independent checkpoint mismatch")
        journal.write_bytes(current[0])
        service_head.write_bytes(current[1])
        passed("missing independent checkpoint and rolled-back ledger both blocked startup")
    finally:
        stop(gateway)
        stop(service)


if __name__ == "__main__":
    check(sys.argv[1:] == ["--disposable-linux-guest"], "Explicit disposable guest acknowledgement required")
    check(sys.platform.startswith("linux") and hasattr(socket, "SO_PEERCRED") and os.geteuid() == 0,
          "Requires a disposable Linux guest with SO_PEERCRED and guest-root UID switching")
    node = shutil.which("node")
    check(node, "Node.js 20+ must be installed in the guest")
    with tempfile.TemporaryDirectory(prefix="voice-otto-uid-", dir="/tmp") as directory:
        main(Path(directory), node)
    print(f"{len(REPORT)} distinct-UID checks passed")
