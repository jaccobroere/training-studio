"""Feedback: capture in the athlete's own database and optionally forward it to a webhook.

The app stores the raw note, triages it and, when FEEDBACK_WEBHOOK_URL is set, posts it to
that webhook (which might, say, open an issue). The app
never talks to an issue tracker itself, and the operator never needs an in-app admin role.
"""
