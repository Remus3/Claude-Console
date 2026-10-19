import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "{kit_dir}"))
import kit_test_guard  # noqa: E402

kit_test_guard.install(globals(), root=Path(__file__).resolve().parents[1])
