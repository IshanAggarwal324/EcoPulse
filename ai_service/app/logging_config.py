import logging
import sys
from pathlib import Path

from app.config import Settings


def setup_logging(settings: Settings) -> None:
    level = getattr(logging, settings.log_level.upper(), logging.INFO)
    handlers = [logging.StreamHandler(sys.stdout)]

    if settings.log_file:
        log_path = Path(settings.log_file)
        try:
            log_path.parent.mkdir(parents=True, exist_ok=True)
            handlers.append(logging.FileHandler(log_path))
        except OSError:
            logging.getLogger(__name__).warning(
                "Could not open log file %s; using stdout only",
                settings.log_file,
            )

    logging.basicConfig(
        level=level,
        format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
        handlers=handlers,
        force=True,
    )
