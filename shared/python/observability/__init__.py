"""EcoPulse shared observability package (Module 7.3).

Canonical structured-logging implementation for all Python services. The
single source of truth — ``logging_config.py`` — is imported by ai_service and
genai-service so their JSON log schema matches the backend's
(``ts, level, service, correlationId, msg`` + request fields).
"""
