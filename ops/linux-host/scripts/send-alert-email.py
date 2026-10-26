#!/usr/bin/env python3
import os
import smtplib
import ssl
import sys
from email.message import EmailMessage


def send(message):
    def required(name):
        value = os.environ.get(name, '')
        if not value or '\r' in value or '\n' in value:
            raise ValueError('missing or invalid configuration')
        return value

    host = required('TT_SMTP_HOST')
    port = int(required('TT_SMTP_PORT'))
    mode = required('TT_SMTP_TLS')
    if mode not in ('starttls', 'implicit') or not 1 <= port <= 65535:
        raise ValueError('invalid SMTP configuration')
    user = required('TT_SMTP_USERNAME')
    password = required('TT_SMTP_PASSWORD')
    mail = EmailMessage()
    mail['From'] = required('TT_ALERT_FROM')
    mail['To'] = required('TT_ALERT_TO')
    mail['Subject'] = 'Terminal platform alert'
    mail.set_content(message[:4096])
    context = ssl.create_default_context()
    client = (smtplib.SMTP_SSL(host, port, timeout=10, context=context)
              if mode == 'implicit' else smtplib.SMTP(host, port, timeout=10))
    with client:
        if mode == 'starttls':
            client.ehlo()
            client.starttls(context=context)
            client.ehlo()
        client.login(user, password)
        if client.send_message(mail):
            raise RuntimeError('recipient rejected')


if __name__ == '__main__':
    try:
        if len(sys.argv) != 2:
            raise ValueError('expected one alert message')
        send(sys.argv[1])
    except Exception:
        print('Alert email delivery failed; check protected SMTP configuration and connectivity.', file=sys.stderr)
        sys.exit(1)
