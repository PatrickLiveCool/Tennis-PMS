"""Python -I excludes untrusted CWD, PYTHONPATH, and user site packages."""
import sys

sys.path.insert(0, "/opt/tennis-green-pms-release/lib")
from server import serve
from common import ReleaseError

try:
    serve()
except BaseException as error:
    if isinstance(error, SystemExit):
        raise
    print("Tennis-Green-PMS: " + (str(error) if isinstance(error, ReleaseError) else "operation failed; operator investigation required"), file=sys.stderr)
    sys.exit(1)
