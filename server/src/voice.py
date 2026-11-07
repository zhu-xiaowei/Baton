"""Voice input/output: Transcribe streaming URLs and spoken replies (Polly, optional Bedrock brief).

Speech-to-text never passes through this server: the client streams microphone PCM straight to
Amazon Transcribe over a short-lived presigned WebSocket URL. Text-to-speech results are cached in
the images bucket under voice/<account>/, which install.sh expires with a lifecycle rule.
"""
import hashlib
import os
import re
from concurrent.futures import ThreadPoolExecutor
from functools import lru_cache
from urllib.parse import urlencode

import boto3
from botocore.auth import SigV4QueryAuth
from botocore.awsrequest import AWSRequest
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

import api_key

router = APIRouter(prefix="/api/voice")

STT_URL_TTL = 300
AUDIO_URL_TTL = 600
ORIGINAL_MAX_CHARS = 6000
POLLY_CHUNK_CHARS = 1000
BRIEF_MAX_CHARS = 200
VOICES = {"zh": "Zhiyu", "en": "Joanna"}
CACHE_VERSION = "1"


def voice_enabled():
    return os.environ.get("VOICE_ENABLED", "false") == "true"


def _require_enabled():
    if not voice_enabled():
        raise HTTPException(404, "Voice mode is not enabled on this server")


def _region():
    return os.environ.get("AWS_REGION", "us-east-1")


def _bucket():
    bucket = os.environ.get("BRIDGE_IMAGES_BUCKET", "")
    if not bucket:
        raise HTTPException(503, "Voice storage is not configured")
    return bucket


@lru_cache(maxsize=1)
def _s3():
    return boto3.client("s3", region_name=_region(),
                        config=Config(signature_version="s3v4", s3={"addressing_style": "virtual"}))


@lru_cache(maxsize=1)
def _polly():
    return boto3.client("polly", region_name=_region())


@lru_cache(maxsize=1)
def _bedrock():
    return boto3.client("bedrock-runtime", region_name=_region(),
                        config=Config(read_timeout=20, retries={"max_attempts": 1}))


# ---------- speech-to-text ----------

class SttUrlRequest(BaseModel):
    # "auto" lets Transcribe pick one of VOICE_AUTO_LANGUAGES per dictation.
    language: str = Field(default="auto", pattern=r"^(auto|[a-z]{2}-[A-Z]{2})$")
    sampleRate: int = Field(default=16000, ge=8000, le=48000)


def transcribe_url(language="auto", sample_rate=16000, credentials=None, region=None):
    region = region or _region()
    host = f"transcribestreaming.{region}.amazonaws.com:8443"
    query = {
        "media-encoding": "pcm",
        "sample-rate": str(sample_rate),
        "enable-partial-results-stabilization": "true",
        "partial-results-stability": "medium",
    }
    if language == "auto":
        query["identify-language"] = "true"
        query["language-options"] = os.environ.get("VOICE_AUTO_LANGUAGES") or "zh-CN,en-US"
    else:
        query["language-code"] = language
        vocabulary = os.environ.get("VOICE_VOCABULARY_NAME", "")
        if vocabulary:
            query["vocabulary-name"] = vocabulary
    request = AWSRequest(method="GET",
                         url=f"https://{host}/stream-transcription-websocket?{urlencode(query)}")
    credentials = credentials or boto3.Session().get_credentials().get_frozen_credentials()
    SigV4QueryAuth(credentials, "transcribe", region, expires=STT_URL_TTL).add_auth(request)
    return "wss://" + request.url[len("https://"):]


@router.get("/config")
def config():
    return {"enabled": voice_enabled()}


@router.post("/stt-url")
def stt_url(body: SttUrlRequest):
    _require_enabled()
    return {"url": transcribe_url(body.language, body.sampleRate),
            "sampleRate": body.sampleRate, "expiresIn": STT_URL_TTL}


# ---------- text-to-speech ----------

_FENCE = re.compile(r"^\s*(```|~~~).*?^\s*\1[^\n]*$", re.M | re.S)
_TABLE_ROW = re.compile(r"^\s*\|.*\|\s*$", re.M)
_HTML = re.compile(r"<[^>\n]+>")
_IMAGE = re.compile(r"!\[([^\]]*)\]\([^)]*\)")
_LINK = re.compile(r"\[([^\]]+)\]\([^)]*\)")
_URL = re.compile(r"https?://\S+")
_PATH = re.compile(r"(?<![\w])(?:~|\.{1,2})?(?:/[\w.@-]+){2,}/?")
_INLINE_CODE = re.compile(r"`([^`\n]*)`")
_EMPHASIS = re.compile(r"(\*\*|__|\*|_|~~)(?=\S)(.+?)(?<=\S)\1")
_LINE_MARKERS = re.compile(r"^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+|[-*_]{3,}\s*$)", re.M)
_CJK = re.compile(r"[㐀-鿿豈-﫿]")
_LATIN = re.compile(r"[A-Za-z]")


def language_of(text):
    cjk = len(_CJK.findall(text))
    latin = len(_LATIN.findall(text))
    # A Chinese reply full of identifiers is still Chinese; ~20 Latin letters per CJK char tips it.
    return "en" if latin > cjk * 20 else "zh"


def speakable_text(markdown):
    """Markdown reply -> plain prose worth hearing: no code, tables, URLs or long paths."""
    text = _FENCE.sub("\n", markdown or "")
    text = _TABLE_ROW.sub("", text)
    text = _IMAGE.sub(r"\1", text)
    text = _LINK.sub(r"\1", text)
    text = _URL.sub("", text)
    text = _PATH.sub(lambda m: m.group(0).rstrip("/").rsplit("/", 1)[-1], text)
    text = _INLINE_CODE.sub(r"\1", text)
    text = _HTML.sub("", text)
    text = _LINE_MARKERS.sub("", text)
    for _ in range(2):
        text = _EMPHASIS.sub(r"\2", text)
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n\s*\n+", "\n", text)
    return text.strip()


_SENTENCE_END = re.compile(r"(?<=[。！？!?；;\n])|(?<=[.](?=\s))")


def split_chunks(text, limit=POLLY_CHUNK_CHARS):
    chunks, current = [], ""
    for piece in _SENTENCE_END.split(text):
        while len(piece) > limit:
            head, piece = piece[:limit], piece[limit:]
            if current:
                chunks.append(current)
                current = ""
            chunks.append(head)
        if len(current) + len(piece) > limit and current:
            chunks.append(current)
            current = ""
        current += piece
    if current.strip():
        chunks.append(current)
    return [chunk.strip() for chunk in chunks if chunk.strip()]


def truncate_original(text, language, limit=ORIGINAL_MAX_CHARS):
    if len(text) <= limit:
        return text, False
    cut = text[:limit]
    boundary = max(cut.rfind(mark) for mark in "。！？!?\n.")
    if boundary > limit // 2:
        cut = cut[:boundary + 1]
    note = "后面的内容比较长，请在屏幕上查看。" if language == "zh" else " The rest is long; please read it on screen."
    return cut + "\n" + note, True


BRIEF_PROMPT = (
    "You turn a coding assistant's reply into a short spoken briefing for its user, who is listening "
    "on a phone. Rules: answer in the reply's main language (Chinese replies get Chinese); at most "
    "{limit} characters (Chinese) or {words} words (other languages); keep conclusions, results, "
    "numbers, problems and anything the user must decide or do; never read code, commands, paths, "
    "URLs or table cells verbatim - describe them; plain spoken sentences, no Markdown, no lists, "
    "no greeting or preamble such as 'here is the briefing'. Output only the briefing."
)


def make_brief(markdown, model_id=None, limit=BRIEF_MAX_CHARS):
    model_id = model_id or os.environ.get("VOICE_BRIEF_MODEL_ID", "global.anthropic.claude-haiku-5-5")
    source = _FENCE.sub(lambda m: m.group(0) if len(m.group(0)) < 600 else "\n[code omitted]\n", markdown)
    request = {
        "modelId": model_id,
        "system": [{"text": BRIEF_PROMPT.format(limit=limit, words=limit // 2)}],
        "messages": [{"role": "user", "content": [{"text": source[:40000]}]}],
        "inferenceConfig": {"maxTokens": 600},
    }
    # Claude models think by default and can spend the whole budget before answering.
    try:
        response = _bedrock().converse(**request,
                                       additionalModelRequestFields={"thinking": {"type": "disabled"}})
    except ClientError as error:
        if error.response.get("Error", {}).get("Code") != "ValidationException":
            raise
        response = _bedrock().converse(**request)
    blocks = response.get("output", {}).get("message", {}).get("content", [])
    text = "".join(block.get("text", "") for block in blocks if isinstance(block, dict))
    return speakable_text(text)


def synthesize(text, language):
    voice = VOICES.get(language, VOICES["zh"])

    def one(chunk):
        result = _polly().synthesize_speech(Text=chunk, VoiceId=voice, Engine="neural",
                                            OutputFormat="mp3", SampleRate="24000")
        return result["AudioStream"].read()

    chunks = split_chunks(text)
    if not chunks:
        raise ValueError("nothing to synthesize")
    if len(chunks) == 1:
        return one(chunks[0])
    with ThreadPoolExecutor(max_workers=min(6, len(chunks))) as pool:
        return b"".join(pool.map(one, chunks))


class SpeakRequest(BaseModel):
    text: str = Field(min_length=1, max_length=200000)
    brief: bool = True
    threshold: int = Field(default=300, ge=50, le=5000)


def cache_key(account, text, mode, language):
    digest = hashlib.sha256("\0".join([CACHE_VERSION, mode, language, text]).encode()).hexdigest()[:32]
    return f"voice/{account}/{digest}.mp3"


def _presigned(key):
    return _s3().generate_presigned_url("get_object", Params={
        "Bucket": _bucket(), "Key": key, "ResponseContentType": "audio/mpeg",
        "ResponseCacheControl": "private, max-age=600",
    }, ExpiresIn=AUDIO_URL_TTL)


def _cached(key):
    try:
        head = _s3().head_object(Bucket=_bucket(), Key=key)
    except ClientError as error:
        # Without s3:ListBucket a missing object answers 403, not 404.
        if error.response.get("Error", {}).get("Code") in ("403", "404", "NoSuchKey", "NotFound", "Forbidden"):
            return None
        raise
    return head.get("Metadata", {})


@router.post("/speak")
def speak(body: SpeakRequest, request: Request):
    _require_enabled()
    account = api_key.account_id(request.headers.get("x-api-key", ""))
    plain = speakable_text(body.text)
    if not plain:
        raise HTTPException(422, "Nothing to read aloud")
    language = language_of(plain)
    mode = "brief" if body.brief and len(plain) > body.threshold else "original"
    key = cache_key(account, body.text if mode == "brief" else plain, mode, language)
    bucket = _bucket()
    meta = _cached(key)
    if meta is not None:
        return {"url": _presigned(key), "mode": meta.get("mode", mode), "cached": True}

    spoken, fallback = plain, False
    if mode == "brief":
        try:
            spoken = make_brief(body.text, limit=min(BRIEF_MAX_CHARS, body.threshold)) or plain
        except (BotoCoreError, ClientError) as error:
            print(f"[voice] brief failed, reading original: {error}")
            mode, fallback = "original", True
    truncated = False
    if mode == "original":
        spoken, truncated = truncate_original(spoken, language)
    try:
        audio = synthesize(spoken, language)
    except (BotoCoreError, ClientError) as error:
        print(f"[voice] synthesis failed: {error}")
        raise HTTPException(502, "Speech synthesis failed")
    _s3().put_object(Bucket=bucket, Key=key, Body=audio, ContentType="audio/mpeg",
                     Metadata={"mode": mode})
    return {"url": _presigned(key), "mode": mode, "spokenText": spoken, "cached": False,
            "truncated": truncated, "briefFallback": fallback}
