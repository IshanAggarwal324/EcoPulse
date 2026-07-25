"""
TensorFlow native runtime environment configuration.

TensorFlow's native (absl/C++) runtime probes for a CUDA device the moment
``tensorflow``/``tensorflow.keras`` is imported. On hosts with no CUDA
driver (e.g. Render), that probe fails and the native logger — which
bypasses Python's ``logging`` module entirely — writes an unstructured
``E0000 ... cuda_platform.cc`` line straight to stdout/stderr.

Both the native logger's verbosity (``TF_CPP_MIN_LOG_LEVEL``) and the CUDA
device probe itself (``CUDA_VISIBLE_DEVICES``) are controlled via
environment variables that **must be set before the first
``import tensorflow`` anywhere in the process** — once the native runtime
has initialized, changing these variables has no effect.

This module is intentionally TensorFlow-free (stdlib ``os`` only) so it can
be imported cheaply from any lazy-import call site without pulling in
TensorFlow itself.
"""

import os

_TRUTHY_VALUES = {"1", "true", "yes"}


def configure_tf_runtime() -> dict:
    """Configure TensorFlow's native runtime environment for CPU-only or
    GPU-opt-in operation, before TensorFlow is imported.

    Reads ``ECOPULSE_ENABLE_GPU`` (truthy for ``"1"``/``"true"``/``"yes"``,
    case-insensitive) to decide whether to force CPU-only mode.

    - ``TF_CPP_MIN_LOG_LEVEL`` is set to ``"3"`` via ``setdefault`` (never
      overrides an operator-provided value), suppressing native
      INFO/WARNING/ERROR log lines (only FATAL surfaces).
    - When GPU opt-in is falsy (default), ``CUDA_VISIBLE_DEVICES`` is set to
      ``"-1"`` via ``setdefault`` (hides all GPUs, forcing CPU-only
      execution), never overriding an operator-provided value.
    - When GPU opt-in is truthy, ``CUDA_VISIBLE_DEVICES`` is left untouched
      entirely (not even a ``setdefault`` call), so TensorFlow's normal GPU
      discovery proceeds as the operator/platform configured it.

    Idempotent and safe to call multiple times / from multiple sites in the
    same process, in any order, as long as it runs before ``import
    tensorflow``.

    Returns:
        dict with keys ``"mode"`` (``"cpu"`` or ``"gpu"``),
        ``"cuda_visible_devices"`` (resolved value, may be ``None``), and
        ``"tf_cpp_min_log_level"`` (resolved value).
    """
    os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "3")

    gpu_enabled = os.environ.get("ECOPULSE_ENABLE_GPU", "").strip().lower() in _TRUTHY_VALUES

    if not gpu_enabled:
        os.environ.setdefault("CUDA_VISIBLE_DEVICES", "-1")

    mode = "gpu" if gpu_enabled else "cpu"

    return {
        "mode": mode,
        "cuda_visible_devices": os.environ.get("CUDA_VISIBLE_DEVICES"),
        "tf_cpp_min_log_level": os.environ.get("TF_CPP_MIN_LOG_LEVEL"),
    }
