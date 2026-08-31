import json
import logging
import os
import tempfile
from typing import List, Literal, Optional

from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, HTTPException, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from fastapi.staticfiles import StaticFiles
from openai import AsyncOpenAI
from pydantic import BaseModel, Field

load_dotenv()

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("regional-captions-backend")

app = FastAPI(title="Regional Translator Backend")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

INDIAN_LANGUAGES = {
    "hi": "Hindi",
    "mr": "Marathi",
    "ta": "Tamil",
    "te": "Telugu",
    "kn": "Kannada",
    "bn": "Bengali",
    "gu": "Gujarati",
    "ml": "Malayalam",
    "pa": "Punjabi",
}

# Read API Keys from environment variable (supports Groq & OpenAI)
groq_key = os.getenv("GROQ_API_KEY")
openai_key = os.getenv("OPENAI_API_KEY")

if groq_key and not groq_key.startswith("your_"):
    logger.info("Configured provider: Groq API")
    client = AsyncOpenAI(api_key=groq_key, base_url="https://api.groq.com/openai/v1")
    STT_MODEL = "whisper-large-v3-turbo"
    CHAT_MODEL = "llama-3.3-70b-versatile"
elif openai_key and not openai_key.startswith("your_"):
    logger.info("Configured provider: OpenAI API")
    client = AsyncOpenAI(api_key=openai_key)
    STT_MODEL = "whisper-1"
    CHAT_MODEL = "gpt-4o-mini"
else:
    logger.warning("No valid GROQ_API_KEY or OPENAI_API_KEY found.")
    client = None
    STT_MODEL = "whisper-large-v3-turbo"
    CHAT_MODEL = "llama-3.3-70b-versatile"

frontend_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "frontend"))
if os.path.exists(frontend_dir):
    app.mount("/studio", StaticFiles(directory=frontend_dir, html=True), name="frontend")


# Helper: Build contextual system prompt supporting Wispr Flow AI Smart Polish, Tone, and Custom Glossary
def build_translation_system_prompt(
    target_language_name: str,
    tone: str = "casual",
    smart_cleanup: bool = True,
    glossary: str = "",
    is_dictation: bool = False,
) -> str:
    prompt_parts = [
        f"You are an expert native AI speech translator and dialogue polish editor for {target_language_name}."
    ]

    if smart_cleanup:
        prompt_parts.append(
            "CRITICAL SMART POLISH: Remove all verbal filler words ('um', 'uh', 'like', 'you know', 'basically', 'matlab', etc.), "
            "stutters, false starts, and self-corrections (e.g. 'Monday... no, Tuesday at 4' -> translate only 'Tuesday at 4'). "
            "Output clear, concise, fluent speech."
        )

    if tone == "formal":
        prompt_parts.append(
            f"TONE: Use formal, respectful, and professional vocabulary suitable for business meetings, news, or formal documents in {target_language_name}."
        )
    elif tone == "summary":
        prompt_parts.append(
            f"TONE: Provide a concise, high-impact bulleted summary of key points translated into {target_language_name}."
        )
    else:  # casual / default
        prompt_parts.append(
            f"TONE: Use natural spoken-register dialogue in {target_language_name} as spoken in contemporary daily conversation."
        )

    if glossary and glossary.strip():
        terms = [t.strip() for t in glossary.split(",") if t.strip()]
        if terms:
            prompt_parts.append(
                f"CUSTOM GLOSSARY / JARGON: Strictly preserve and correctly spell the following domain terms/proper nouns: {', '.join(terms)}."
            )

    if is_dictation:
        prompt_parts.append(
            f"OUTPUT FORMAT: Return ONLY the final polished translated text in {target_language_name} script, formatted with proper punctuation and capitalizations. "
            "Do NOT include markdown formatting, explanations, quotation marks, or notes."
        )
    else:
        prompt_parts.append(
            f"OUTPUT FORMAT: Return ONLY the translated sentences in {target_language_name} script. "
            "Do not include transliterations, notes, or extra markdown."
        )

    return " ".join(prompt_parts)


# Pydantic models for request validation
class SubtitleSegment(BaseModel):
    id: Optional[int] = None
    start: float = Field(default=0.0, ge=0.0)
    end: float = Field(default=0.0, ge=0.0)
    original: str = ""
    translated: Optional[str] = ""


class ExportRequest(BaseModel):
    segments: List[SubtitleSegment] = []
    format: Literal["srt", "vtt", "txt"] = "srt"


@app.get("/")
async def root():
    return {
        "status": "ok",
        "message": "TranslateSub Live Captions & Wispr Flow Studio Backend",
        "studio_url": "/studio",
    }


@app.websocket("/ws/translate")
async def translate_websocket(
    websocket: WebSocket,
    lang: str = "hi",
    tone: str = "casual",
    smart_cleanup: bool = True,
    glossary: str = "",
):
    await websocket.accept()
    target_language_name = INDIAN_LANGUAGES.get(lang.lower(), "Hindi")
    logger.info(
        f"WebSocket client connected. Lang: {target_language_name} ({lang}), Tone: {tone}, Polish: {smart_cleanup}, Glossary: {glossary}"
    )

    if not client:
        logger.error("GROQ_API_KEY or OPENAI_API_KEY environment variable is missing or empty.")

    system_prompt = build_translation_system_prompt(
        target_language_name=target_language_name,
        tone=tone,
        smart_cleanup=smart_cleanup,
        glossary=glossary,
        is_dictation=False,
    )

    try:
        while True:
            audio_bytes = await websocket.receive_bytes()
            if not audio_bytes or len(audio_bytes) < 100:
                continue

            if not client:
                await websocket.send_json({
                    "original": "[Backend Error]",
                    "translated": "API Key missing. Please set GROQ_API_KEY or OPENAI_API_KEY in backend .env file.",
                })
                continue

            tmp_path = None
            try:
                # Write binary chunk to a temporary file
                with tempfile.NamedTemporaryFile(suffix=".webm", delete=False) as tmp_file:
                    tmp_file.write(audio_bytes)
                    tmp_path = tmp_file.name

                # 1. Transcribe audio chunk with Whisper (using glossary as prompt hint if provided)
                stt_kwargs = {
                    "model": STT_MODEL,
                }
                if glossary and glossary.strip():
                    stt_kwargs["prompt"] = glossary.strip()

                with open(tmp_path, "rb") as audio_file:
                    stt_kwargs["file"] = ("audio.webm", audio_file)
                    stt_response = await client.audio.transcriptions.create(**stt_kwargs)

                transcript_text = getattr(stt_response, "text", "").strip()

                # Skip empty/silent chunks
                if not transcript_text or len(transcript_text) < 2:
                    logger.info("Silence or unintelligible audio chunk skipped.")
                    continue

                logger.info(f"[STT Original]: {transcript_text}")

                # 2. Translate text into target Indian language
                translation_response = await client.chat.completions.create(
                    model=CHAT_MODEL,
                    messages=[
                        {"role": "system", "content": system_prompt},
                        {"role": "user", "content": transcript_text},
                    ],
                    temperature=0.3,
                )

                translated_text = translation_response.choices[0].message.content.strip()
                logger.info(f"[Translated - {target_language_name}]: {translated_text}")

                # 3. Send translated text back over WebSocket
                await websocket.send_json({
                    "original": transcript_text,
                    "translated": translated_text,
                })

            except Exception as chunk_err:
                logger.error(f"Error processing audio chunk: {chunk_err}")
                try:
                    await websocket.send_json({
                        "error": f"Audio processing error: {str(chunk_err)}"
                    })
                except Exception:
                    pass
            finally:
                if tmp_path and os.path.exists(tmp_path):
                    try:
                        os.remove(tmp_path)
                    except Exception as clean_err:
                        logger.warning(f"Could not remove temp file {tmp_path}: {clean_err}")

    except WebSocketDisconnect:
        logger.info("WebSocket connection closed cleanly by client.")
    except Exception as ws_err:
        logger.error(f"WebSocket error: {ws_err}")


# Wispr Flow Feature: Direct Voice Dictation Endpoint
@app.post("/api/dictate")
async def dictate_audio(
    file: UploadFile = File(...),
    lang: str = Form("hi"),
    tone: str = Form("casual"),
    smart_cleanup: bool = Form(True),
    glossary: str = Form(""),
):
    if not client:
        return {"error": "GROQ_API_KEY or OPENAI_API_KEY is missing or invalid."}

    target_language_name = INDIAN_LANGUAGES.get(lang.lower(), "Hindi")
    logger.info(
        f"[Dictate] Processing speech for {target_language_name} (Tone: {tone}, Polish: {smart_cleanup}, Glossary: {glossary})"
    )

    content = await file.read()
    ext = os.path.splitext(file.filename)[1] if file.filename else ".webm"
    if not ext:
        ext = ".webm"

    tmp_path = None
    try:
        with tempfile.NamedTemporaryFile(suffix=ext, delete=False) as tmp_file:
            tmp_file.write(content)
            tmp_path = tmp_file.name

        # 1. Transcribe with Whisper
        stt_kwargs = {"model": STT_MODEL}
        if glossary and glossary.strip():
            stt_kwargs["prompt"] = glossary.strip()

        with open(tmp_path, "rb") as audio_file:
            stt_kwargs["file"] = (file.filename or f"dictate{ext}", audio_file)
            stt_response = await client.audio.transcriptions.create(**stt_kwargs)

        raw_text = getattr(stt_response, "text", "").strip()
        if not raw_text:
            return {"original": "", "text": "", "language": target_language_name}

        # 2. Apply AI Smart Polish and Translation
        system_prompt = build_translation_system_prompt(
            target_language_name=target_language_name,
            tone=tone,
            smart_cleanup=smart_cleanup,
            glossary=glossary,
            is_dictation=True,
        )

        translation_response = await client.chat.completions.create(
            model=CHAT_MODEL,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": raw_text},
            ],
            temperature=0.2,
        )

        polished_text = translation_response.choices[0].message.content.strip()

        return {
            "original": raw_text,
            "text": polished_text,
            "language": target_language_name,
        }

    except Exception as err:
        logger.error(f"[Dictate] Error: {err}", exc_info=True)
        return {"error": str(err)}
    finally:
        if tmp_path and os.path.exists(tmp_path):
            try:
                os.remove(tmp_path)
            except Exception:
                pass


@app.post("/api/transcribe-file")
async def transcribe_file(
    file: UploadFile = File(...),
    lang: str = Form("hi"),
    tone: str = Form("casual"),
    smart_cleanup: bool = Form(True),
    glossary: str = Form(""),
):
    if not client:
        return {"error": "GROQ_API_KEY or OPENAI_API_KEY environment variable is missing or invalid."}

    target_language_name = INDIAN_LANGUAGES.get(lang.lower(), "Hindi")
    logger.info(
        f"Processing file upload '{file.filename}' for language {target_language_name} (Tone: {tone}, Polish: {smart_cleanup})"
    )

    # Check file size
    content = await file.read()
    file_size_mb = len(content) / (1024 * 1024)
    logger.info(f"Uploaded file size: {file_size_mb:.2f} MB")

    ext = os.path.splitext(file.filename)[1] if file.filename else ".mp4"
    if not ext:
        ext = ".mp4"

    tmp_path = None
    try:
        with tempfile.NamedTemporaryFile(suffix=ext, delete=False) as tmp_file:
            tmp_file.write(content)
            tmp_path = tmp_file.name

        # 1. Transcribe with Whisper using verbose_json to retrieve timestamps
        try:
            stt_kwargs = {
                "model": STT_MODEL,
                "response_format": "verbose_json",
            }
            if glossary and glossary.strip():
                stt_kwargs["prompt"] = glossary.strip()

            with open(tmp_path, "rb") as audio_file:
                stt_kwargs["file"] = (file.filename or f"audio{ext}", audio_file)
                stt_response = await client.audio.transcriptions.create(**stt_kwargs)
        except Exception as stt_err:
            logger.error(f"STT API Error ({STT_MODEL}): {stt_err}", exc_info=True)
            return {"error": f"Audio Transcription Failed: {str(stt_err)}"}

        raw_segments = getattr(stt_response, "segments", [])
        if not raw_segments:
            text = getattr(stt_response, "text", "").strip()
            if text:
                raw_segments = [{"start": 0.0, "end": 5.0, "text": text}]
            else:
                return {"segments": []}

        # 2. Extract segments and prepare batch translation
        segment_items = []
        for idx, seg in enumerate(raw_segments):
            start = getattr(seg, "start", 0.0) if not isinstance(seg, dict) else seg.get("start", 0.0)
            end = getattr(seg, "end", 0.0) if not isinstance(seg, dict) else seg.get("end", 0.0)
            text = getattr(seg, "text", "").strip() if not isinstance(seg, dict) else seg.get("text", "").strip()
            if text:
                segment_items.append({
                    "id": idx + 1,
                    "start": round(float(start), 2),
                    "end": round(float(end), 2),
                    "original": text,
                })

        if not segment_items:
            return {"segments": []}

        # 3. Batch translate using LLM with Wispr Flow AI Smart Polish & Tone
        texts_to_translate = [item["original"] for item in segment_items]
        system_prompt = (
            f"{build_translation_system_prompt(target_language_name, tone, smart_cleanup, glossary, is_dictation=False)} "
            f"Translate the following JSON list of audio transcript lines into {target_language_name}. "
            f"Return ONLY a JSON array of strings containing the exact translated sentences in target language script, "
            f"matching the order of the input array. Do NOT output markdown code blocks or explanations."
        )

        user_content = json.dumps(texts_to_translate, ensure_ascii=False)

        try:
            translation_response = await client.chat.completions.create(
                model=CHAT_MODEL,
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_content},
                ],
                temperature=0.3,
            )
            raw_content = translation_response.choices[0].message.content.strip()

            # Clean JSON formatting if wrapped in ```json ... ```
            if raw_content.startswith("```"):
                raw_content = raw_content.split("```")[1]
                if raw_content.startswith("json"):
                    raw_content = raw_content[4:].strip()

            translated_list = json.loads(raw_content)
            for idx, item in enumerate(segment_items):
                if idx < len(translated_list):
                    item["translated"] = translated_list[idx]
                else:
                    item["translated"] = item["original"]
        except Exception as trans_err:
            logger.warning(f"Batch translation error, falling back to original: {trans_err}")
            for item in segment_items:
                item["translated"] = item["original"]

        return {"segments": segment_items}

    except Exception as err:
        logger.error(f"Error processing file transcription: {err}", exc_info=True)
        return {"error": str(err)}
    finally:
        if tmp_path and os.path.exists(tmp_path):
            try:
                os.remove(tmp_path)
            except Exception:
                pass


def format_timestamp_srt(seconds: float) -> str:
    hrs = int(seconds // 3600)
    mins = int((seconds % 3600) // 60)
    secs = int(seconds % 60)
    millis = int(round((seconds - int(seconds)) * 1000))
    return f"{hrs:02d}:{mins:02d}:{secs:02d},{millis:03d}"


def format_timestamp_vtt(seconds: float) -> str:
    hrs = int(seconds // 3600)
    mins = int((seconds % 3600) // 60)
    secs = int(seconds % 60)
    millis = int(round((seconds - int(seconds)) * 1000))
    return f"{hrs:02d}:{mins:02d}:{secs:02d}.{millis:03d}"


@app.post("/api/export-subtitles")
async def export_subtitles(payload: ExportRequest):
    segments = payload.segments
    fmt = payload.format.lower()

    if fmt == "vtt":
        output = ["WEBVTT\n"]
        for seg in segments:
            start_str = format_timestamp_vtt(seg.start)
            end_str = format_timestamp_vtt(seg.end)
            text = seg.translated or seg.original or ""
            output.append(f"{start_str} --> {end_str}\n{text}\n")
        content = "\n".join(output)
        media_type = "text/vtt"
        filename = "subtitles.vtt"
    elif fmt == "txt":
        output = [seg.translated or seg.original or "" for seg in segments]
        content = "\n\n".join(output)
        media_type = "text/plain"
        filename = "subtitles.txt"
    else:  # SRT
        output = []
        for idx, seg in enumerate(segments, 1):
            start_str = format_timestamp_srt(seg.start)
            end_str = format_timestamp_srt(seg.end)
            text = seg.translated or seg.original or ""
            output.append(f"{idx}\n{start_str} --> {end_str}\n{text}\n")
        content = "\n".join(output)
        media_type = "application/x-subrip"
        filename = "subtitles.srt"

    return Response(
        content=content,
        media_type=media_type,
        headers={"Content-Disposition": f"attachment; filename={filename}"},
    )
