import os

# The stub backend and the local stack listen on loopback; never route those through an HTTP(S)_PROXY from the env.
for k in ("NO_PROXY", "no_proxy"):
    os.environ[k] = ",".join(filter(None, [os.environ.get(k), "127.0.0.1", "localhost"]))
