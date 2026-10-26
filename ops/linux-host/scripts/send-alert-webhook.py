#!/usr/bin/env python3
import json
import os
import sys
import urllib.parse
import urllib.request

ALLOWED_HOSTS = ('discord.com', 'discordapp.com')


def webhook_url():
    value = os.environ.get('TT_ALERT_WEBHOOK_URL', '')
    if not value or '\r' in value or '\n' in value:
        raise ValueError('missing or invalid configuration')
    parsed = urllib.parse.urlsplit(value)
    if parsed.scheme != 'https' or parsed.hostname not in ALLOWED_HOSTS or not parsed.path.startswith('/api/webhooks/'):
        raise ValueError('invalid webhook URL')
    return value


def send(message):
    body = json.dumps({'content': message[:1900], 'allowed_mentions': {'parse': []}}).encode()
    request = urllib.request.Request(webhook_url(), data=body, method='POST', headers={
        'content-type': 'application/json',
        'user-agent': 'terminal-l1-l2-alert',
    })
    with urllib.request.urlopen(request, timeout=10) as response:
        if not 200 <= response.status < 300:
            raise RuntimeError('webhook rejected')


if __name__ == '__main__':
    try:
        if len(sys.argv) != 2:
            raise ValueError('expected one alert message')
        send(sys.argv[1])
    except Exception:
        print('Alert webhook delivery failed; check protected webhook configuration and connectivity.', file=sys.stderr)
        sys.exit(1)
