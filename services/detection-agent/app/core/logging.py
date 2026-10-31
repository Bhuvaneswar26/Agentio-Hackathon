import logging
import sys


def setup_logging(level: str = "INFO") -> None:
    logging.basicConfig(
        level=getattr(logging, level.upper(), logging.INFO),
        stream=sys.stdout,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
        force=True,
    )
