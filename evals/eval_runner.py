#!/usr/bin/env python3
"""Deterministic prompt/tool/backend and transcript checks for the voice agent."""

import argparse
import json
from pathlib import Path
import re
import sys
from typing import Dict, List, Sequence, Tuple
from urllib.parse import urlparse


def load_json(path: Path):
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def check(condition: bool, code: str, message: str, severity: str = "error") -> Dict:
    return {"pass": bool(condition), "code": code, "severity": severity, "message": message}


def static_checks(repo: Path, config: Dict) -> List[Dict]:
    results: List[Dict] = []
    # The agent surface moved out of retell/ when the telephony vendor was
    # dropped. These two files are vendor-neutral and are still the canonical
    # definition of what the agent can do and how it is told to behave; the
    # ElevenLabs provisioner renders both from exactly these.
    #
    # This mattered more than it looks: static_checks() returns early when a
    # required file is missing, so while these paths pointed at the deleted
    # retell/ directory only 6 of the 48 checks ran at all, and the eval
    # reported "4 passed" instead of failing.
    tools_path = repo / "agent" / "tools.json"
    prompt_path = repo / "agent" / "system-prompt.txt"
    validation_path = repo / "src" / "utils" / "validation.ts"
    routes_path = repo / "src" / "routes" / "appointments.ts"
    index_path = repo / "src" / "index.ts"
    package_path = repo / "package.json"

    required = [tools_path, prompt_path, validation_path, routes_path, index_path, package_path]
    for path in required:
        results.append(check(path.is_file(), "file:%s" % path.name, "Required file exists: %s" % path.relative_to(repo)))
    if any(not path.is_file() for path in required):
        return results

    try:
        tools = load_json(tools_path)
        results.append(check(isinstance(tools, list), "tools:json", "agent/tools.json is a JSON array"))
    except Exception as exc:
        results.append(check(False, "tools:json", "agent/tools.json parses: %s" % exc))
        return results

    by_name = {item.get("name"): item for item in tools if isinstance(item, dict)}
    expected = set(config.get("expected_tools", []))
    results.append(check(expected.issubset(set(by_name)), "tools:expected", "All expected agent tools are present"))

    allowed_hosts = set(config.get("production_hosts", []))
    for name, tool in sorted(by_name.items()):
        parsed = urlparse(tool.get("url", ""))
        results.append(check(parsed.scheme == "https", "tool:%s:https" % name, "%s uses HTTPS" % name))
        results.append(check(not allowed_hosts or parsed.hostname in allowed_hosts, "tool:%s:host" % name, "%s uses an allowlisted host" % name))

    prompt = prompt_path.read_text(encoding="utf-8")
    prompt_upper = prompt.upper()
    invariants = {
        "prompt:current-date": "GET_CURRENT_DATE" in prompt_upper,
        "prompt:one-question": "ONE QUESTION AT A TIME" in prompt_upper,
        "prompt:no-dob": "NEVER ASK FOR DATE OF BIRTH" in prompt_upper,
        "prompt:exact-time": "EXACT TIME" in prompt_upper,
        "prompt:confirm-before-create": "DO NOT CALL CREATE_APPOINTMENT UNTIL THE CALLER CONFIRMS" in prompt_upper,
        "prompt:emergency": "EMERGENCY ESCALATION" in prompt_upper,
    }
    for code, passed in invariants.items():
        results.append(check(passed, code, "Prompt contains invariant %s" % code.split(":", 1)[1]))

    validation = validation_path.read_text(encoding="utf-8")
    routes = routes_path.read_text(encoding="utf-8")
    index = index_path.read_text(encoding="utf-8")
    package = load_json(package_path)

    embedded_secret = False
    setup_path = repo / "aws-setup.sh"
    if setup_path.is_file():
        for line in setup_path.read_text(encoding="utf-8", errors="ignore").splitlines():
            compact = line.strip()
            if len(compact) > 1000 and re.fullmatch(r"[A-Za-z0-9+/=]+", compact):
                embedded_secret = True
                break
    results.append(check(not embedded_secret, "security:embedded-credential", "Tracked setup scripts contain no embedded credential payload"))

    create_props = by_name.get("create_appointment", {}).get("parameters", {}).get("properties", {})
    create_required = set(by_name.get("create_appointment", {}).get("parameters", {}).get("required", []))
    results.append(check("full_name" in create_required, "contract:create:name", "create_appointment requires full_name"))
    results.append(check("full_name" in routes and "caller_name" in validation, "contract:create:name-alias", "Backend normalizes full_name to caller_name"))

    if "first_visit" in create_props:
        first_visit_supported = "first_visit" in validation or "body.first_visit" in routes
        results.append(check(first_visit_supported, "contract:create:first-visit", "Backend persists the Retell first_visit field"))
    if "referral_source" in create_props:
        referral_supported = "referral_source" in validation or "body.referral_source" in routes
        results.append(check(referral_supported, "contract:create:referral", "Backend persists the Retell referral_source field"))

    route_names = {
        "get_current_date": "/current-date",
        "check_availability": "/check-availability",
        "create_appointment": "/create-appointment",
        "reschedule_appointment": "/reschedule-appointment",
        "cancel_appointment": "/cancel-appointment",
        "create_callback": "/create-callback",
        "search_services": "/search-services",
    }
    all_source = "\n".join(
        path.read_text(encoding="utf-8")
        for path in (repo / "src" / "routes").glob("*.ts")
    )
    for name, route in route_names.items():
        if name in expected:
            results.append(check(route in all_source, "route:%s" % name, "Backend implements %s" % route))

    # Was: src/routes/retell.ts. The telephony vendor's route is gone; the
    # voice vendor's two webhooks are verified in this middleware instead —
    # one by vendor signature, one by a shared secret we issue.
    webhook_middleware = (repo / "src" / "middleware" / "voice-webhook.ts")
    webhook_source = webhook_middleware.read_text(encoding="utf-8").lower() if webhook_middleware.is_file() else ""
    results.append(check(
        "timingsafeequal" in webhook_source and "createhmac" in webhook_source,
        "security:webhook-signature",
        "Voice vendor webhook authenticity is verified in constant time",
    ))
    results.append(check("rate" in index.lower() and "limit" in index.lower(), "security:rate-limit", "Public tool endpoints have rate limiting"))
    results.append(check("cors()" not in index.replace(" ", ""), "security:cors", "CORS is restricted instead of globally open"))
    results.append(check("stored_phones" not in routes, "privacy:phone-logging", "Appointment lookup does not log stored phone numbers"))
    results.append(check("test" in package.get("scripts", {}), "tests:script", "package.json defines a deterministic test script"))

    deploy_path = repo / ".github" / "workflows" / "deploy.yml"
    if deploy_path.is_file():
        deploy = deploy_path.read_text(encoding="utf-8")
        results.append(check("environment:" in deploy and "production" in deploy, "deploy:approval", "Production deploy uses a protected GitHub environment"))

    return results


def is_subsequence(required: Sequence[str], actual: Sequence[str]) -> bool:
    cursor = 0
    for item in actual:
        if cursor < len(required) and item == required[cursor]:
            cursor += 1
    return cursor == len(required)


def transcript_checks(transcript: Dict, scenario: Dict) -> List[Dict]:
    sid = scenario["id"]
    calls = transcript.get("tool_calls", [])
    names = [call.get("name") for call in calls]
    results = [
        check(is_subsequence(scenario.get("required_tool_sequence", []), names), "%s:tool-sequence" % sid, "Required tool order is preserved"),
    ]
    for forbidden in scenario.get("forbidden_tools", []):
        results.append(check(forbidden not in names, "%s:forbidden:%s" % (sid, forbidden), "Forbidden tool was not called: %s" % forbidden))

    for call in calls:
        name = call.get("name")
        args = call.get("arguments", {})
        if name == "check_availability":
            results.append(check(bool(args.get("date") and args.get("time")), "%s:availability-args" % sid, "Availability call has date and exact time"))
        if name == "create_appointment":
            required = {"full_name", "phone", "service", "date", "time"}
            results.append(check(required.issubset(set(args)), "%s:create-args" % sid, "Booking call has all required real values"))

    agent_turns = [turn.get("text", "") for turn in transcript.get("turns", []) if turn.get("role") == "agent"]
    results.append(check(all(text.count("?") <= 1 for text in agent_turns), "%s:one-question" % sid, "Agent asks at most one question per turn"))
    results.append(check(all(not re.search(r"[{}]", text) for text in agent_turns), "%s:no-json" % sid, "Agent never speaks JSON or braces"))

    for key, value in scenario.get("expected_outcome", {}).items():
        results.append(check(transcript.get("outcome", {}).get(key) == value, "%s:outcome:%s" % (sid, key), "Outcome %s equals %r" % (key, value)))
    return results


def summarize(results: List[Dict]) -> Tuple[Dict, int]:
    failures = [item for item in results if not item["pass"] and item["severity"] == "error"]
    summary = {
        "passed": len(results) - len(failures),
        "failed": len(failures),
        "total": len(results),
        "results": results,
    }
    return summary, 0 if not failures else 1


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, required=True)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--static", action="store_true")
    parser.add_argument("--transcripts", type=Path)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    repo = args.repo.expanduser().resolve()
    config = load_json(args.config)
    if args.transcripts:
        scenario_path = Path(__file__).resolve().parents[1] / "evals" / "scenarios" / "voice-agent.json"
        scenarios = {item["id"]: item for item in load_json(scenario_path)}
        results: List[Dict] = []
        with args.transcripts.expanduser().open("r", encoding="utf-8") as handle:
            for line_number, line in enumerate(handle, 1):
                if not line.strip():
                    continue
                transcript = json.loads(line)
                sid = transcript.get("scenario_id")
                if sid not in scenarios:
                    results.append(check(False, "line:%s:scenario" % line_number, "Unknown scenario_id: %s" % sid))
                    continue
                results.extend(transcript_checks(transcript, scenarios[sid]))
    else:
        results = static_checks(repo, config)
    summary, status = summarize(results)
    print(json.dumps(summary, indent=2, sort_keys=True))
    return status


if __name__ == "__main__":
    sys.exit(main())
