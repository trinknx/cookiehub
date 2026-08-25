"""One-shot Chrome-impersonated GET via curl_cffi.

Reads a JSON request from stdin: {"url": str, "headers": {}, "proxy": str|null, "timeout": ms-as-seconds}
Writes {"status": int, "body": str} to stdout. Any failure exits non-zero with a traceback on stderr.
(The adapter loader only imports .js files, so this helper safely lives in the same directory.)
"""
import json
import sys

from curl_cffi import requests


def main():
    req = json.load(sys.stdin)
    kwargs = {"impersonate": "chrome", "timeout": req.get("timeout") or 12}
    if req.get("proxy"):
        kwargs["proxies"] = {"http": req["proxy"], "https": req["proxy"]}
    r = requests.get(req["url"], headers=req.get("headers") or {}, **kwargs)
    json.dump({"status": r.status_code, "body": r.text}, sys.stdout)


if __name__ == "__main__":
    main()
