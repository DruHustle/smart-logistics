#!/usr/bin/env python3
"""Compose deployment with image cleanup only after verified readiness."""
import argparse
import fcntl
import json
import os
import pathlib
import re
import subprocess
import time
import urllib.request

from image_retention import cleanup, container_images, inspect_image, ownership

LOCAL_ORIGIN = "http://127.0.0.1:8080"
# Production reaches its private PostgreSQL container on the VM only through this
# internal network and verifies it against this read-only CA (verify-full TLS).
DATABASE_NETWORK = "onesa-logistics-database"
DATABASE_CA = "/run/onesa/logistics-db-ca.crt"


def verify(url, revision):
    base = url.rstrip("/")
    with urllib.request.urlopen(base + "/ready", timeout=10) as response:
        if json.load(response).get("status") != "ready":
            raise RuntimeError("Deployment is not ready; image cleanup skipped")
    with urllib.request.urlopen(base + "/version", timeout=10) as response:
        version = json.load(response)
    if version.get("apiContract") != 2 or (revision and version.get("revision") != revision):
        raise RuntimeError("Release identity mismatch; image cleanup skipped")


def rendered(command):
    """Render the exact deployment model; it holds secrets, so it is never printed."""
    result = subprocess.run([*command, "config", "--format", "json"],
                            check=True, capture_output=True, text=True)
    return json.loads(result.stdout)


def require_database_attachment(config, services):
    """Refuse an Oracle deployment that would detach a service from its database."""
    networks = config.get("networks") or {}
    for name in services or ["app"]:
        service = (config.get("services") or {}).get(name) or {}
        attached = [networks.get(key) or {} for key in service.get("networks") or {}]
        database = [network for network in attached
                    if network.get("name") == DATABASE_NETWORK and network.get("external") is True]
        ca = [volume for volume in service.get("volumes") or []
              if volume.get("type") == "bind" and volume.get("target") == DATABASE_CA
              and volume.get("read_only") is True]
        if len(database) != 1 or len(ca) != 1:
            raise RuntimeError(
                f"{name} must join {DATABASE_NETWORK} and mount its CA read-only at "
                f"{DATABASE_CA}; include compose.application-database.yaml. Nothing was changed")


def retained_services(before, after, previous):
    result = {}
    for service, image in after.items():
        retained = previous.get(service, {})
        # Relocation can restore verified images and retention state before any
        # destination container exists. Preserve that last current image too.
        old = before.get(service) or retained.get("current")
        rollback = old if old and old != image else retained.get("rollback")
        result[service] = {"current": image, "rollback": rollback}
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project-directory", type=pathlib.Path, default=pathlib.Path.cwd())
    parser.add_argument("--project-name", default="imsop-app-backend")
    parser.add_argument("--file", action="append", required=True)
    parser.add_argument("--origin", required=True, help="Gateway origin for /ready and /version checks")
    parser.add_argument("--expect-revision", help="Mandatory exact SHA for Oracle production")
    parser.add_argument("--build", action="store_true")
    parser.add_argument("--service", action="append", default=[])
    args = parser.parse_args()
    root = args.project_directory.resolve()
    if args.expect_revision and not re.fullmatch(r"[a-f0-9]{40}", args.expect_revision):
        parser.error("--expect-revision must be an exact SHA")
    if args.project_name != "imsop-app-backend":
        parser.error("This deployment helper manages only imsop-app-backend")
    oracle = args.origin.rstrip("/") != LOCAL_ORIGIN
    if oracle and not args.expect_revision:
        parser.error("An exact revision is required outside the local development gateway")
    with (root / ".deployment.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        state_path = root / ".image-retention.json"
        previous = json.loads(state_path.read_text()).get("services", {}) if state_path.exists() else {}

        def managed():
            result = {}
            for row in container_images(args.project_name).values():
                if row["service"] and ownership(inspect_image(row["image"])):
                    if row["service"] in result:
                        raise RuntimeError("Ambiguous service replicas; cleanup skipped")
                    result[row["service"]] = row["image"]
            return result

        before = managed()
        command = ["docker", "compose", "--project-directory", str(root), "--project-name", args.project_name]
        for file in args.file:
            command += ["-f", str((root / file).resolve())]
        if oracle:
            require_database_attachment(rendered(command), args.service)
        command += ["up", "--detach", "--wait", "--wait-timeout", "120"]
        if args.build:
            command.append("--build")
        if args.service:
            command += ["--no-deps", *args.service]
        subprocess.run(command, check=True)
        verify(args.origin, args.expect_revision)
        services = retained_services(before, managed(), previous)
        keep = sorted({identity for row in services.values() for identity in row.values() if identity})
        if not keep:
            raise RuntimeError("No managed images found; cleanup skipped")
        # Verify rollback availability before replacing the policy or deleting.
        for identity in keep:
            inspect_image(identity)
        temp = state_path.with_suffix(".tmp")
        temp.write_text(json.dumps({"services": services, "verifiedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}, indent=2) + "\n")
        temp.chmod(0o600)
        os.replace(temp, state_path)
        result = cleanup(keep, apply=True)
        print(json.dumps(result, indent=2))
        if result["errors"]:
            raise RuntimeError("Deployment is ready; some unused images could not be removed (see report)")


if __name__ == "__main__":
    main()
