import base64
import json
import pathlib
import sys


def main() -> None:
    recordings_dir = pathlib.Path(sys.argv[1])
    files = sorted(recordings_dir.glob("*.krec"))
    if len(files) < 5:
        raise SystemExit(f"expected at least 5 recording files, found {len(files)}")

    all_payloads: list[str] = []
    for path in files:
        lines = path.read_text(encoding="utf-8").splitlines()
        if len(lines) < 2:
            raise SystemExit(f"{path.name} is missing event lines")

        header = json.loads(lines[0])
        if header.get("type") != "header":
            raise SystemExit(f"{path.name} has wrong header type: {header!r}")
        if header.get("format") != "kino.raw-event-log":
            raise SystemExit(f"{path.name} has wrong recording format: {header!r}")
        if header.get("version") != 1:
            raise SystemExit(f"{path.name} has wrong version header: {header!r}")
        if not isinstance(header.get("width"), int) or not isinstance(
            header.get("height"), int
        ):
            raise SystemExit(f"{path.name} has invalid dimensions: {header!r}")
        if header["width"] <= 0 or header["height"] <= 0:
            raise SystemExit(f"{path.name} has non-positive dimensions: {header!r}")
        if "env" not in header or "SHELL" not in header["env"]:
            raise SystemExit(f"{path.name} is missing env.SHELL: {header!r}")

        saw_exit = False
        for raw in lines[1:]:
            event = json.loads(raw)
            if event.get("type") != "event":
                raise SystemExit(f"{path.name} has malformed event: {event!r}")
            if not isinstance(event.get("offset_ms"), int):
                raise SystemExit(f"{path.name} has non-numeric offset: {event!r}")
            event_type = event.get("event")
            if event_type not in {"i", "o", "r", "x"}:
                raise SystemExit(f"{path.name} has invalid event type: {event!r}")

            if event_type in {"i", "o"}:
                payload = event.get("data_b64")
                if not isinstance(payload, str):
                    raise SystemExit(f"{path.name} has missing data payload: {event!r}")
                all_payloads.append(base64.b64decode(payload).decode("utf-8", errors="replace"))
            elif event_type == "r":
                if not isinstance(event.get("width"), int) or not isinstance(
                    event.get("height"), int
                ):
                    raise SystemExit(f"{path.name} has invalid resize payload: {event!r}")
            elif event_type == "x":
                if not isinstance(event.get("exit_code"), int):
                    raise SystemExit(f"{path.name} has invalid exit payload: {event!r}")
                saw_exit = True

        if not saw_exit:
            raise SystemExit(f"{path.name} is missing an exit event")

    joined = "\n".join(all_payloads)
    if "interactive-smoke" not in joined:
        raise SystemExit("interactive session payload missing from recording files")
    if "command-smoke" not in joined:
        raise SystemExit("command session payload missing from recording files")
    if "tty-command-smoke" not in joined:
        raise SystemExit("tty command payload missing from recording files")
    if "stdin-smoke" not in joined:
        raise SystemExit("stdin-fed command payload missing from recording files")
    if "Listing... Done" not in joined:
        raise SystemExit("progress-style output tail missing from recording files")
    if "progress-tail-smoke" not in joined:
        raise SystemExit("post-progress shell tail missing from recording files")


if __name__ == "__main__":
    main()
