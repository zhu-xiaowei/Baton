"""Convert a stored presentation to a cached PDF preview (invoked asynchronously by the API)."""
import os
import signal
import subprocess
import tempfile

import boto3

MAX_BYTES = 100 * 1024 * 1024
TIMEOUT_SECONDS = 100
ENV = {**os.environ, "HOME": "/tmp", "XDG_CACHE_HOME": "/tmp/cache"}
# PowerPoint's default picture resolution: sharp on tablets/desktop and when zoomed, ~25% smaller PDF.
PDF_FILTER = ('pdf:impress_pdf_Export:{"ReduceImageResolution":{"type":"boolean","value":"true"},'
              '"MaxImageResolution":{"type":"long","value":"220"}}')
_s3 = boto3.client("s3")


class PreviewError(Exception):
    pass


def convert(source, outdir):
    process = subprocess.Popen(
        ["soffice", "--headless", "--norestore", "-env:UserInstallation=file:///tmp/lo-profile",
         "--convert-to", PDF_FILTER, "--outdir", outdir, source],
        env=ENV, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, start_new_session=True)
    try:
        _, stderr = process.communicate(timeout=TIMEOUT_SECONDS)
    except subprocess.TimeoutExpired:
        # soffice forks soffice.bin; a survivor would keep the profile locked for the next request.
        os.killpg(process.pid, signal.SIGKILL)
        process.wait()
        raise PreviewError("Conversion timed out.")
    pdf = os.path.join(outdir, os.path.splitext(os.path.basename(source))[0] + ".pdf")
    if not os.path.exists(pdf):
        print("soffice failed:", stderr.decode(errors="replace")[-1000:])
        raise PreviewError("Could not convert this file.")
    return pdf


def handler(event, context):
    if event.get("warmup"):
        with tempfile.TemporaryDirectory() as work:
            convert("/opt/app/warmup.fodp", work)
        return {"ok": True}

    bucket = os.environ["BRIDGE_IMAGES_BUCKET"]
    source, preview = event["source"], event["preview"]
    try:
        if _s3.head_object(Bucket=bucket, Key=source)["ContentLength"] > MAX_BYTES:
            raise PreviewError("File is too large to preview (over 100 MB).")
        with tempfile.TemporaryDirectory() as work:
            path = os.path.join(work, "source" + os.path.splitext(source)[1])
            _s3.download_file(bucket, source, path)
            pdf = convert(path, work)
            _s3.upload_file(pdf, bucket, preview + ".pdf", ExtraArgs={"ContentType": "application/pdf"})
        return {"ok": True}
    except Exception as error:
        if isinstance(error, PreviewError):
            message = str(error)
        else:
            print("conversion error:", repr(error))
            message = "Could not convert this file."
        _s3.put_object(Bucket=bucket, Key=preview + ".error", Body=message.encode())
        return {"ok": False, "error": message}
    finally:
        _s3.delete_object(Bucket=bucket, Key=preview + ".pending")
