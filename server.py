"""
CharChat server.

What this program does:
  * serves the web page (index.html and the files next to it)
  * stores every chat in one SQLite database file:   data/app.db
  * keeps your OpenRouter API key on this computer:  data/settings.json
  * talks to OpenRouter on the web page's behalf, so the key never goes to the browser

SQLite is a whole database kept in a single file - there is no database program to
install or start, Python can read and write it on its own.

Uses only Python's standard library, so there is nothing to install.

Run:   python server.py                 (only this computer can open it)
       python server.py --lan           (other devices on your network / Tailscale can open it too)
       python server.py --port 9000     (use a different port)
"""
import argparse
import base64
import hashlib
import ipaddress
import json
import os
import re
import secrets
import shutil
import sqlite3
import sys
import threading
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, unquote

APP_VERSION = "0.5.0"

APP_DIR = os.path.dirname(os.path.abspath(__file__))
CHARACTERS_DIR = os.path.join(APP_DIR, "characters")
CHATS_DIR = os.path.join(APP_DIR, "chats")    # the old version 3 folder: imported once, then renamed
DATA_DIR = os.path.join(APP_DIR, "data")      # everything characterl lives here (never committed to git)
DB_PATH = os.path.join(DATA_DIR, "app.db")
SETTINGS_PATH = os.path.join(DATA_DIR, "settings.json")
SAFE = re.compile(r"^[A-Za-z0-9_-]{1,80}$")   # stops tricks like "../../windows" in names

OPENROUTER = "https://openrouter.ai/api/v1"
OPENROUTER_AUTH = "https://openrouter.ai/auth"

# The only plain files the web page ever needs. Everything else in this folder -
# data/ (the database and your API key), user.md, server.py, .git - is refused.
# A list of what IS allowed is safer than a list of what isn't: a tricky
# address like /%64ata/ or /DATA/ can't slip past it.
PUBLIC_FOLDERS = ("static", "lib", "assets")
AVATAR_FILE = re.compile(r"^characters[\\/][A-Za-z0-9_-]{1,80}[\\/]avatar\.(png|jpg|webp|gif)$", re.I)

# Extra host names allowed to reach the app (from --allow-host), such as a
# Tailscale name. localhost and plain IP addresses are always allowed.
EXTRA_HOST_NAMES = set()


def host_allowed(host_header):
    """Refuse requests that reached us under somebody else's domain name.

    A trick called DNS rebinding lets a web page on evil.example point its own
    name at 127.0.0.1, so the browser treats this app as part of that page. The
    browser still sends "Host: evil.example", though, which is how we spot it.
    """
    host = (host_header or "").strip().lower()
    if not host:
        return True                      # very old tools send no Host; browsers always do
    if host.startswith("["):             # an IPv6 address: [::1]:8080
        name = host[1:].split("]", 1)[0]
    else:
        name = host.split(":", 1)[0]
    name = name.rstrip(".")
    if name == "localhost" or name.endswith(".localhost") or name in EXTRA_HOST_NAMES:
        return True
    try:
        ipaddress.ip_address(name)       # a typed-in IP address can't be a rebinding trick
        return True
    except ValueError:
        return False

# Set from the command line in main(); the web page asks for it via /api/status.
LAN_MODE = False


def migrate_characters_folder():
    """Earlier versions kept these in a folder called "personas". Move it across."""
    old_folder = os.path.join(APP_DIR, "personas")
    if not os.path.isdir(old_folder):
        return
    if os.path.isdir(CHARACTERS_DIR):
        print("  Found both personas/ and characters/ - leaving personas/ where it is.")
        return
    try:
        os.rename(old_folder, CHARACTERS_DIR)
        print("  Renamed your personas folder to characters.")
    except OSError as err:
        print("  Could not rename personas/ to characters/ (%s)." % err)
        return
    # keep the saved "Undo last save" copies lined up with the new folder name
    old_backups = os.path.join(DATA_DIR, ".backup", "personas")
    new_backups = os.path.join(DATA_DIR, ".backup", "characters")
    if os.path.isdir(old_backups) and not os.path.isdir(new_backups):
        try:
            os.rename(old_backups, new_backups)
        except OSError:
            pass


def ensure_data_dirs():
    """Create the data folder on first run, so the app always has somewhere to write.

    data/app.db        the chat database
    data/settings.json your API key + app settings
    data/media/...     generated images and videos
    data/.backup/      one previous version of each edited .md file, for "Undo last save"
    """
    for folder in (DATA_DIR,
                   os.path.join(DATA_DIR, "media", "images"),
                   os.path.join(DATA_DIR, "media", "videos"),
                   os.path.join(DATA_DIR, "media", "uploads"),
                   os.path.join(DATA_DIR, ".backup")):
        os.makedirs(folder, exist_ok=True)


# ===========================================================================
# Settings (data/settings.json) - written only by this program
# ===========================================================================
# Every setting the app knows about, with its starting value. Anything not in
# this list is ignored, so a stray or hand-edited key cannot sneak in.
DEFAULT_SETTINGS = {
    "openrouter_key": "",
    "model": "openrouter/auto",
    "ollama_url": "http://localhost:11434",
    "ollama_num_ctx": 8192,
    "ollama_model": "",
    "openrouter_tools": [],
}

# Things OpenRouter can do on the model's behalf. OpenRouter runs these itself
# and feeds the result back to the model, so there is nothing to run here.
SERVER_TOOLS = {
    "web_search": "openrouter:web_search",
    "web_fetch": "openrouter:web_fetch",
    "datetime": "openrouter:datetime",
}

_settings_lock = threading.Lock()


def load_settings():
    with _settings_lock:
        return _read_settings()


def _read_settings():
    """Read the settings file. Only call this while holding _settings_lock."""
    try:
        with open(SETTINGS_PATH, "r", encoding="utf-8") as f:
            saved = json.load(f)
    except Exception:
        saved = {}                           # missing or damaged file: fall back to the defaults
    settings = dict(DEFAULT_SETTINGS)
    if isinstance(saved, dict):
        for name in DEFAULT_SETTINGS:
            if name in saved and saved[name] is not None:
                settings[name] = saved[name]
    return settings


def save_settings(changes):
    """Merge `changes` into the saved settings and write the file back."""
    # Read, change and write as one step. Two saves at the same moment (say, the
    # sign-in saving a key while the page saves a model) could otherwise both
    # read the old file, and the second write would undo the first.
    with _settings_lock:
        settings = _read_settings()
        for name, value in changes.items():
            if name in DEFAULT_SETTINGS:
                settings[name] = value

        tmp = SETTINGS_PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(settings, f, ensure_ascii=False, indent=2)
        os.replace(tmp, SETTINGS_PATH)       # swap in one step, so a crash never half-writes it
        if os.name != "nt":
            # On Linux and Mac: make the file readable by its owner only, because it holds the key.
            try:
                os.chmod(SETTINGS_PATH, 0o600)
            except OSError:
                pass
    return settings


def mask_key(key):
    """sk-or-v1-abcdef...a3f9  ->  sk-or-...a3f9   (safe to show on screen)"""
    if not key:
        return ""
    if len(key) < 12:
        return "..." + key[-2:]
    return key[:6] + "..." + key[-4:]


def public_settings():
    """The version of the settings the browser is allowed to see: no full key."""
    s = load_settings()
    key = s["openrouter_key"]
    return {
        "connected": bool(key),
        "key_masked": mask_key(key),
        "model": s["model"],
        "ollama_url": s["ollama_url"],
        "ollama_num_ctx": s["ollama_num_ctx"],
        "ollama_model": s["ollama_model"],
        "openrouter_tools": s["openrouter_tools"],
    }


# ===========================================================================
# The database
# ===========================================================================
# One table per kind of thing. "REFERENCES chats(id) ON DELETE CASCADE" means:
# when a chat is deleted, its messages are deleted with it, automatically.
SCHEMA = """
CREATE TABLE IF NOT EXISTS chats (
    id      TEXT PRIMARY KEY,
    character_id TEXT NOT NULL,
    title   TEXT,
    created INTEGER,
    updated INTEGER
);

CREATE TABLE IF NOT EXISTS messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id    TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    position   INTEGER,          -- 0, 1, 2 ... so the messages keep their order
    role       TEXT,             -- "user" or "assistant"
    content    TEXT,
    provider   TEXT,             -- "openrouter" or "ollama"
    model      TEXT,
    usage_json TEXT,             -- token counts and cost, as JSON text
    stats_json TEXT,             -- speed and timing stats, as JSON text
    thinking    TEXT,            -- the model's own reasoning, when it shows it
    images_json TEXT,            -- pictures attached to the message, as JSON text
    created    INTEGER
);

CREATE TABLE IF NOT EXISTS media (
    id          TEXT PRIMARY KEY,
    kind        TEXT CHECK(kind IN ('image', 'video')),
    status      TEXT,
    prompt      TEXT,
    model       TEXT,
    params_json TEXT,
    files_json  TEXT,
    cost        REAL,
    job_id      TEXT,
    error       TEXT,
    created     INTEGER,
    updated     INTEGER
);

CREATE INDEX IF NOT EXISTS idx_chats_character ON chats(character_id, updated DESC);
CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, position);
"""

_db = None
# The server answers several browser requests at the same time, each on its own
# thread. SQLite is happiest with one writer at a time, so every database call
# below takes this lock first - that is what keeps two saves from colliding.
_db_lock = threading.Lock()


def init_db():
    global _db
    _db = sqlite3.connect(DB_PATH, check_same_thread=False)
    _db.row_factory = sqlite3.Row            # lets us read columns by name: row["title"]
    _db.execute("PRAGMA foreign_keys = ON")  # makes the "delete the messages too" rule work
    _db.execute("PRAGMA journal_mode = WAL") # lets reading and writing happen at the same time
    migrate_old_columns()                    # must run before the schema, so indexes can be made
    _db.executescript(SCHEMA)
    _db.commit()


def migrate_old_columns():
    """Earlier versions called characters "personas". Update an older database."""
    existing = [row[1] for row in _db.execute("PRAGMA table_info(chats)")]
    if not existing:
        return                               # brand new database: nothing to update
    if "persona" in existing and "character_id" not in existing:
        _db.execute("ALTER TABLE chats RENAME COLUMN persona TO character_id")
        _db.execute("DROP INDEX IF EXISTS idx_chats_persona")
        _db.commit()
        print("  Updated the database: chats are now filed by character.")

    # Somewhere to keep a model's own reasoning, which it writes before answering,
    # and the pictures attached to a message.
    message_columns = [row[1] for row in _db.execute("PRAGMA table_info(messages)")]
    if message_columns and "thinking" not in message_columns:
        _db.execute("ALTER TABLE messages ADD COLUMN thinking TEXT")
        _db.commit()
    if message_columns and "images_json" not in message_columns:
        _db.execute("ALTER TABLE messages ADD COLUMN images_json TEXT")
        _db.commit()


def list_chats(character):
    """The sidebar list for one character: newest chat first."""
    with _db_lock:
        rows = _db.execute(
            "SELECT id, title, updated FROM chats WHERE character_id = ? ORDER BY updated DESC",
            (character,)
        ).fetchall()
    return [{"id": r["id"], "title": r["title"] or "Untitled", "updated": r["updated"] or 0}
            for r in rows]


def load_chat(character, chat_id):
    """One full chat, in the same shape the web page has always used."""
    with _db_lock:
        chat = _db.execute("SELECT * FROM chats WHERE id = ? AND character_id = ?",
                           (chat_id, character)).fetchone()
        if chat is None:
            return None
        rows = _db.execute("SELECT * FROM messages WHERE chat_id = ? ORDER BY position",
                           (chat_id,)).fetchall()

    messages = []
    for r in rows:
        m = {"role": r["role"], "content": r["content"] or ""}
        if r["provider"]:
            m["provider"] = r["provider"]
        if r["model"]:
            m["model"] = r["model"]
        if r["thinking"]:
            m["thinking"] = r["thinking"]
        if r["images_json"]:
            try:
                m["images"] = json.loads(r["images_json"])
            except ValueError:
                pass
        for key, column in (("usage", "usage_json"), ("stats", "stats_json")):
            if r[column]:
                try:
                    m[key] = json.loads(r[column])
                except ValueError:
                    pass          # a broken value is skipped rather than breaking the whole chat
        messages.append(m)

    return {"id": chat["id"], "character": chat["character_id"], "title": chat["title"] or "Untitled",
            "messages": messages, "created": chat["created"], "updated": chat["updated"]}


def save_chat(character, chat_id, data):
    """Save a whole chat: the chat row, then all of its messages."""
    now = int(time.time() * 1000)
    title = data.get("title") or "Untitled"
    created = data.get("created") or now
    updated = data.get("updated") or now
    messages = data.get("messages") or []

    # "with _db" wraps everything in one transaction: either all of it is saved
    # or none of it is, so a crash can never leave half a chat behind.
    with _db_lock, _db:
        changed = _db.execute(
            "UPDATE chats SET character_id = ?, title = ?, updated = ? WHERE id = ?",
            (character, title, updated, chat_id)
        ).rowcount
        if not changed:
            _db.execute("INSERT INTO chats (id, character_id, title, created, updated) VALUES (?, ?, ?, ?, ?)",
                        (chat_id, character, title, created, updated))

        # Simplest correct approach: replace this chat's messages with the ones just sent.
        _db.execute("DELETE FROM messages WHERE chat_id = ?", (chat_id,))
        for position, m in enumerate(messages):
            if not isinstance(m, dict):
                continue
            _db.execute(
                """INSERT INTO messages (chat_id, position, role, content, provider, model,
                                         usage_json, stats_json, thinking, images_json, created)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (chat_id, position, m.get("role"), m.get("content") or "",
                 m.get("provider"), m.get("model"),
                 json.dumps(m["usage"]) if isinstance(m.get("usage"), dict) else None,
                 json.dumps(m["stats"]) if isinstance(m.get("stats"), dict) else None,
                 m.get("thinking") or None,
                 json.dumps(m["images"]) if isinstance(m.get("images"), list) and m["images"] else None,
                 m.get("created") or now))


def forget_uploads_for(chat_ids):
    """Delete the picture files attached to these chats, so they don't pile up."""
    if not chat_ids:
        return
    marks = ",".join("?" for _ in chat_ids)
    with _db_lock:
        rows = _db.execute(
            "SELECT images_json FROM messages WHERE chat_id IN (%s) AND images_json IS NOT NULL" % marks,
            list(chat_ids)).fetchall()
    for row in rows:
        try:
            images = json.loads(row["images_json"])
        except ValueError:
            continue
        for image in images:
            path = upload_path(image.get("id", "")) if isinstance(image, dict) else None
            if path:
                try:
                    os.remove(path)
                except OSError:
                    pass


def delete_chat(character, chat_id):
    forget_uploads_for([chat_id])
    with _db_lock, _db:
        _db.execute("DELETE FROM chats WHERE id = ? AND character_id = ?", (chat_id, character))
        # the messages go with it, thanks to ON DELETE CASCADE


def chat_exists(chat_id):
    with _db_lock:
        return _db.execute("SELECT 1 FROM chats WHERE id = ?", (chat_id,)).fetchone() is not None


# ===========================================================================
# One-time import of the version 3 chat files
# ===========================================================================
def import_v3_chats():
    """Copy chats/<character>/<id>.json into the database, then rename the folder.

    Nothing is deleted: the old folder is kept as chats_imported_backup, so the
    files are still there if anything goes wrong.
    """
    if not os.path.isdir(CHATS_DIR):
        return

    imported = already_there = unreadable = 0
    for character in sorted(os.listdir(CHATS_DIR)):
        folder = os.path.join(CHATS_DIR, character)
        if not SAFE.match(character) or not os.path.isdir(folder):
            continue
        for filename in sorted(os.listdir(folder)):
            if not filename.endswith(".json"):
                continue
            try:
                with open(os.path.join(folder, filename), "r", encoding="utf-8") as f:
                    data = json.load(f)
                chat_id = data.get("id") or filename[:-5]
                if not SAFE.match(chat_id):
                    unreadable += 1
                    continue
                if chat_exists(chat_id):
                    already_there += 1
                    continue
                save_chat(character, chat_id, data)
                imported += 1
            except Exception:
                unreadable += 1      # one broken file must not stop the whole import

    # Rename the old folder out of the way (never delete it).
    backup = os.path.join(APP_DIR, "chats_imported_backup")
    attempt = 2
    while os.path.exists(backup):
        backup = os.path.join(APP_DIR, "chats_imported_backup_%d" % attempt)
        attempt += 1
    try:
        os.rename(CHATS_DIR, backup)
        moved_to = os.path.basename(backup)
    except OSError as err:
        moved_to = None
        print("  Could not rename the old chats folder (%s) - it was left where it is." % err)

    if imported or already_there or unreadable:
        print("\n  Imported %d chat(s) from the old chats folder into data/app.db" % imported)
        if already_there:
            print("  %d chat(s) were already in the database and were left alone" % already_there)
        if unreadable:
            print("  %d file(s) could not be read and were skipped" % unreadable)
    else:
        print("\n  The old chats folder was empty - nothing to import.")
    if moved_to:
        print("  The old folder was renamed to %s. Nothing was deleted." % moved_to)


# ===========================================================================
# The Markdown files (a fixed set - the app never creates any others)
# ===========================================================================
#   user.md                          what the model should know about you
#   characters/<name>/identity.md      who this character is
#   characters/<name>/instructions.md  rules it should follow
#   characters/<name>/user.md          only while this character's override is on
CHARACTER_FILES = ("identity", "instructions", "user")

STARTER_IDENTITY = """You are {name}, a friendly and knowledgeable assistant.

Replace this with a description of who {name} is: what they are good at, how
they talk, and anything they should avoid. Everything in this file is sent to
the model at the start of every chat.
"""


def global_user_path():
    return os.path.join(APP_DIR, "user.md")


def character_file_path(name, kind):
    return os.path.join(CHARACTERS_DIR, name, kind + ".md")


def backup_path(real_path):
    """Where the previous version of a file is kept: data/.backup/<same path>."""
    return os.path.join(DATA_DIR, ".backup", os.path.relpath(real_path, APP_DIR))


def read_md(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return f.read()
    except Exception:
        return ""


def save_md(path, content):
    """Write a file, keeping ONE previous version in data/.backup for "Undo last save"."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if os.path.isfile(path):
        previous = backup_path(path)
        os.makedirs(os.path.dirname(previous), exist_ok=True)
        shutil.copy2(path, previous)        # the older backup is replaced: only one is kept
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        f.write(content)
    os.replace(tmp, path)                   # swap in one step, so a crash never half-writes it


def undo_md(path):
    """Put the previous version back. Returns the restored text, or None if there isn't one.

    Because saving always copies the current file into the backup first, pressing
    Undo a second time brings back what you had - the two versions swap places.
    """
    previous = backup_path(path)
    if not os.path.isfile(previous):
        return None
    content = read_md(previous)
    save_md(path, content)
    return content


def md_payload(path, shown_as):
    return {"path": shown_as,
            "content": read_md(path),
            "exists": os.path.isfile(path),
            "has_backup": os.path.isfile(backup_path(path))}


def compose_system_prompt(name):
    """Build the system prompt the model sees. Empty sections are left out entirely."""
    identity = read_md(character_file_path(name, "identity")).strip()
    instructions = read_md(character_file_path(name, "instructions")).strip()

    character_user = character_file_path(name, "user")
    if os.path.isfile(character_user):
        about, source = read_md(character_user).strip(), "character"
    else:
        about, source = read_md(global_user_path()).strip(), "global"
    if not about:
        source = None

    sections = []
    if identity:
        sections.append("# IDENTITY\n" + identity)
    if instructions:
        sections.append("# INSTRUCTIONS\n" + instructions)
    if about:
        sections.append("# ABOUT THE USER\n" + about)
    return "\n\n".join(sections), source


# ---- character profile pictures ----
# Saved next to the character's own files as avatar.<ext>. They are pictures,
# not secrets, so the browser loads them straight from characters/.
AVATAR_TYPES = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif"}
MAX_AVATAR_BYTES = 4 * 1024 * 1024


def avatar_path(name):
    """The character's picture file, whatever its format, or None."""
    folder = os.path.join(CHARACTERS_DIR, name)
    for extension in ("png", "jpg", "webp", "gif"):
        candidate = os.path.join(folder, "avatar." + extension)
        if os.path.isfile(candidate):
            return candidate
    return None


def avatar_url(name):
    path = avatar_path(name)
    if not path:
        return None
    # a changing number on the end stops the browser showing an old picture
    stamp = int(os.path.getmtime(path))
    return "characters/%s/%s?v=%d" % (name, os.path.basename(path), stamp)


def save_avatar(name, data_url):
    """Store a picture sent by the browser as a data URL. Returns an error or None."""
    match = re.match(r"^data:([a-z/+-]+);base64,(.+)$", (data_url or "").strip(), re.S)
    if not match:
        return "That didn't look like an image."
    media_type, encoded = match.group(1), match.group(2)
    if media_type not in AVATAR_TYPES:
        return "Use a PNG, JPEG, WebP or GIF picture."
    try:
        raw = base64.b64decode(encoded)
    except Exception:
        return "That picture couldn't be read."
    if len(raw) > MAX_AVATAR_BYTES:
        return "That picture is too big (the limit is 4 MB)."

    folder = os.path.join(CHARACTERS_DIR, name)
    if not os.path.isdir(folder):
        return "That character doesn't exist."
    remove_avatar(name)                       # only ever one picture per character
    path = os.path.join(folder, "avatar." + AVATAR_TYPES[media_type])
    with open(path, "wb") as f:
        f.write(raw)
    return None


def remove_avatar(name):
    path = avatar_path(name)
    while path:
        try:
            os.remove(path)
        except OSError:
            return
        path = avatar_path(name)


# ---- pictures you attach to a message ----
# Kept as real files rather than inside the database, so a chat full of photos
# doesn't bloat app.db. The message only stores a reference to the file.
UPLOAD_TYPES = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif"}
MAX_UPLOAD_BYTES = 12 * 1024 * 1024
UPLOADS_DIR = os.path.join(DATA_DIR, "media", "uploads")


def save_upload(data_url):
    """Store a picture the browser sent as a data URL. Returns (record, error)."""
    match = re.match(r"^data:([a-z/+-]+);base64,(.+)$", (data_url or "").strip(), re.S)
    if not match:
        return None, "That didn't look like an image."
    media_type, encoded = match.group(1), match.group(2)
    if media_type not in UPLOAD_TYPES:
        return None, "Use a PNG, JPEG, WebP or GIF picture."
    try:
        raw = base64.b64decode(encoded)
    except Exception:
        return None, "That picture couldn't be read."
    if len(raw) > MAX_UPLOAD_BYTES:
        return None, "That picture is too big (the limit is 12 MB)."

    upload_id = new_media_id()
    name = "%s.%s" % (upload_id, UPLOAD_TYPES[media_type])
    os.makedirs(UPLOADS_DIR, exist_ok=True)
    with open(os.path.join(UPLOADS_DIR, name), "wb") as f:
        f.write(raw)
    return {"id": upload_id, "name": name, "media_type": media_type,
            "url": "/api/uploads/" + upload_id}, None


def upload_path(upload_id):
    for extension in UPLOAD_TYPES.values():
        candidate = os.path.join(UPLOADS_DIR, "%s.%s" % (upload_id, extension))
        if os.path.isfile(candidate):
            return candidate
    return None


def slugify(text):
    """"Code Helper" -> "code-helper", so a friendly name becomes a safe folder name."""
    slug = re.sub(r"[^a-z0-9]+", "-", (text or "").strip().lower()).strip("-")
    return slug[:80]


def count_chats(character):
    with _db_lock:
        return _db.execute("SELECT COUNT(*) FROM chats WHERE character_id = ?", (character,)).fetchone()[0]


def character_info(name):
    return {"id": name,
            "override": os.path.isfile(character_file_path(name, "user")),
            "avatar": avatar_url(name),
            "chats": count_chats(name)}


def create_character(friendly_name):
    """Make characters/<slug>/ with a starter identity.md and an empty instructions.md."""
    slug = slugify(friendly_name)
    if not SAFE.match(slug):
        return None, ("Use letters and numbers, for example \"Code Helper\". "
                      "It becomes a folder name like code-helper.")
    folder = os.path.join(CHARACTERS_DIR, slug)
    if os.path.isdir(folder):
        return None, "There is already a character called %s." % slug
    os.makedirs(folder, exist_ok=True)
    pretty = (friendly_name or slug).strip().title()
    save_md(character_file_path(slug, "identity"), STARTER_IDENTITY.format(name=pretty))
    save_md(character_file_path(slug, "instructions"), "")
    return slug, None


def delete_character(name):
    """Remove the character's folder, its chats, and its backups."""
    shutil.rmtree(os.path.join(CHARACTERS_DIR, name), ignore_errors=True)
    shutil.rmtree(os.path.join(DATA_DIR, ".backup", "characters", name), ignore_errors=True)
    with _db_lock:
        owned = [r["id"] for r in _db.execute("SELECT id FROM chats WHERE character_id = ?", (name,))]
    forget_uploads_for(owned)
    with _db_lock, _db:
        _db.execute("DELETE FROM chats WHERE character_id = ?", (name,))
        # the messages go with the chats, thanks to ON DELETE CASCADE


def set_character_override(name, on):
    """Turn "use a custom About-the-user for this character" on or off."""
    path = character_file_path(name, "user")
    if on:
        if not os.path.isfile(path):
            save_md(path, read_md(global_user_path()))   # start from a copy of the global one
    elif os.path.isfile(path):
        previous = backup_path(path)                     # keep a copy, so nothing is truly lost
        os.makedirs(os.path.dirname(previous), exist_ok=True)
        shutil.copy2(path, previous)
        os.remove(path)


# ===========================================================================
# Talking to OpenRouter
# ===========================================================================
def openrouter_json(path, key=None, body=None, timeout=30):
    """Make one request to OpenRouter and return (status_code, parsed_json).

    Never raises: network problems come back as status 0 with an "error" message,
    so the web page can always show something useful.
    """
    headers = {"Content-Type": "application/json",
               "X-Title": "CharChat"}
    if key:
        headers["Authorization"] = "Bearer " + key
    data = json.dumps(body).encode("utf-8") if body is not None else None
    request = urllib.request.Request(OPENROUTER + path, data=data, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as err:
        try:
            return err.code, json.loads(err.read().decode("utf-8"))
        except Exception:
            return err.code, {"error": {"message": "OpenRouter returned %d" % err.code}}
    except Exception as err:
        return 0, {"error": {"message": "Could not reach OpenRouter: %s" % err}}


def openrouter_error_text(payload, fallback="Something went wrong"):
    """Pull a readable sentence out of whatever OpenRouter sent back."""
    if isinstance(payload, dict):
        error = payload.get("error")
        if isinstance(error, dict) and error.get("message"):
            return str(error["message"])
        if isinstance(error, str):
            return error
        if payload.get("message"):
            return str(payload["message"])
    return fallback


# ---- the model list, kept for 10 minutes so we don't re-download 800 KB ----
_models_cache = {"fetched_at": 0, "models": None}
MODELS_CACHE_SECONDS = 600


def openrouter_models():
    """The model list, trimmed to the fields the web page actually uses."""
    now = time.time()
    if _models_cache["models"] and now - _models_cache["fetched_at"] < MODELS_CACHE_SECONDS:
        return 200, {"models": _models_cache["models"], "cached": True}

    status, payload = openrouter_json("/models", timeout=45)
    if status != 200 or not isinstance(payload.get("data"), list):
        if _models_cache["models"]:
            return 200, {"models": _models_cache["models"], "cached": True, "stale": True}
        return (status or 502), {"error": openrouter_error_text(payload, "Could not load the model list")}

    models = []
    for m in payload["data"]:
        pricing = m.get("pricing") or {}
        architecture = m.get("architecture") or {}
        models.append({
            "id": m.get("id"),
            "name": m.get("name") or m.get("id"),
            "context_length": m.get("context_length"),
            # prices are per single token, as text - the web page turns them into "per million"
            "prompt_price": pricing.get("prompt"),
            "completion_price": pricing.get("completion"),
            # tells the page whether this model can look at pictures
            "input_modalities": architecture.get("input_modalities") or [],
        })
    models.sort(key=lambda m: (m["name"] or "").lower())
    _models_cache["models"] = models
    _models_cache["fetched_at"] = now
    return 200, {"models": models, "cached": False}


# ---- image models: the list, and the details of one model ----
# The list has every model's options but no prices; prices live on each model's
# own "endpoints" page, so that is fetched only for the model you pick.
_image_models_cache = {"fetched_at": 0, "models": None}
_image_detail_cache = {}          # model id -> {"fetched_at": ..., "detail": ...}


def openrouter_image_models():
    now = time.time()
    if _image_models_cache["models"] and now - _image_models_cache["fetched_at"] < MODELS_CACHE_SECONDS:
        return 200, {"models": _image_models_cache["models"], "cached": True}

    status, payload = openrouter_json("/images/models", timeout=45)
    if status != 200 or not isinstance(payload.get("data"), list):
        if _image_models_cache["models"]:
            return 200, {"models": _image_models_cache["models"], "cached": True, "stale": True}
        return (status or 502), {"error": openrouter_error_text(payload, "Could not load the image models")}

    models = []
    for m in payload["data"]:
        architecture = m.get("architecture") or {}
        models.append({
            "id": m.get("id"),
            "name": m.get("name") or m.get("id"),
            # what this model accepts: sizes, aspect ratios, how many at once, references
            "supported_parameters": m.get("supported_parameters") or {},
            "input_modalities": architecture.get("input_modalities") or [],
        })
    models.sort(key=lambda m: (m["name"] or "").lower())
    _image_models_cache["models"] = models
    _image_models_cache["fetched_at"] = now
    return 200, {"models": models, "cached": False}


def openrouter_image_model_detail(model_id):
    """The chosen model's price list and per-provider options."""
    now = time.time()
    cached = _image_detail_cache.get(model_id)
    if cached and now - cached["fetched_at"] < MODELS_CACHE_SECONDS:
        return 200, cached["detail"]

    status, payload = openrouter_json("/images/models/%s/endpoints" % model_id, timeout=30)
    if status != 200 or not isinstance(payload.get("endpoints"), list) or not payload["endpoints"]:
        return (status or 502), {"error": openrouter_error_text(payload, "Could not load that model's details")}

    first = payload["endpoints"][0]       # the provider OpenRouter would normally route to
    detail = {
        "id": model_id,
        "provider": first.get("provider_name"),
        "supported_parameters": first.get("supported_parameters") or {},
        "pricing": first.get("pricing") or [],
    }
    _image_detail_cache[model_id] = {"fetched_at": now, "detail": detail}
    return 200, detail


# ---- generated images and videos (the "media" table) ----
MEDIA_EXTENSIONS = {"image/png": "png", "image/jpeg": "jpg", "image/jpg": "jpg",
                    "image/webp": "webp", "image/gif": "gif", "image/svg+xml": "svg",
                    "video/mp4": "mp4", "video/webm": "webm"}
MEDIA_DIRS = {"image": os.path.join(DATA_DIR, "media", "images"),
              "video": os.path.join(DATA_DIR, "media", "videos")}


def new_media_id():
    return time.strftime("%Y-%m-%d_%H%M%S") + "_" + secrets.token_hex(3)


def media_row(row):
    """One database row, in the shape the web page expects."""
    def parsed(text, fallback):
        try:
            return json.loads(text) if text else fallback
        except ValueError:
            return fallback
    return {"id": row["id"], "kind": row["kind"], "status": row["status"],
            "prompt": row["prompt"], "model": row["model"],
            "params": parsed(row["params_json"], {}),
            "files": parsed(row["files_json"], []),
            "cost": row["cost"], "error": row["error"],
            "created": row["created"], "updated": row["updated"]}


def list_media(kind):
    with _db_lock:
        rows = _db.execute("SELECT * FROM media WHERE kind = ? ORDER BY created DESC",
                           (kind,)).fetchall()
    return [media_row(r) for r in rows]


def get_media(media_id):
    with _db_lock:
        row = _db.execute("SELECT * FROM media WHERE id = ?", (media_id,)).fetchone()
    return media_row(row) if row else None


def save_media(record):
    now = int(time.time() * 1000)
    with _db_lock, _db:
        _db.execute(
            """INSERT INTO media (id, kind, status, prompt, model, params_json, files_json,
                                  cost, job_id, error, created, updated)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (record["id"], record["kind"], record["status"], record.get("prompt"),
             record.get("model"), json.dumps(record.get("params") or {}),
             json.dumps(record.get("files") or []), record.get("cost"),
             record.get("job_id"), record.get("error"), now, now))


def delete_media(media_id):
    """Remove the database row and the files that belong to it."""
    item = get_media(media_id)
    if not item:
        return False
    folder = MEDIA_DIRS.get(item["kind"])
    for entry in item["files"]:
        name = entry.get("name") if isinstance(entry, dict) else None
        # only ever delete a plain file name inside our own media folder
        if name and folder and SAFE.match(os.path.splitext(name)[0]) :
            try:
                os.remove(os.path.join(folder, name))
            except OSError:
                pass
    with _db_lock, _db:
        _db.execute("DELETE FROM media WHERE id = ?", (media_id,))
    return True


def generate_images(body):
    """Ask OpenRouter for images, save them, and record them. Returns (status, payload)."""
    key = load_settings()["openrouter_key"]
    if not key:
        return 400, {"error": "No OpenRouter key yet. Open Settings and connect."}

    model = (body.get("model") or "").strip()
    prompt = (body.get("prompt") or "").strip()
    if not model or not prompt:
        return 400, {"error": "Pick a model and write a prompt first."}

    request_body = {"model": model, "prompt": prompt}
    # Only pass on the options the page actually set, so a model never gets a
    # parameter it doesn't understand.
    for name in ("n", "aspect_ratio", "resolution", "size", "output_format", "quality", "background"):
        if body.get(name) not in (None, "", "auto"):
            request_body[name] = body[name]
    references = body.get("input_references")
    if isinstance(references, list) and references:
        request_body["input_references"] = references[:16]

    status, payload = openrouter_json("/images", key=key, body=request_body, timeout=300)
    if status != 200:
        return status, {"error": openrouter_error_text(payload, "Image generation failed")}

    images = payload.get("data") or []
    if not images:
        return 502, {"error": "OpenRouter returned no images."}

    media_id = new_media_id()
    folder = MEDIA_DIRS["image"]
    os.makedirs(folder, exist_ok=True)
    saved = []
    for index, image in enumerate(images):
        encoded = image.get("b64_json")
        if not encoded:
            continue
        media_type = image.get("media_type") or "image/png"
        name = "%s_%d.%s" % (media_id, index, MEDIA_EXTENSIONS.get(media_type, "png"))
        try:
            with open(os.path.join(folder, name), "wb") as f:
                f.write(base64.b64decode(encoded))
        except Exception as err:
            return 500, {"error": "Could not save the image: %s" % err}
        saved.append({"name": name, "media_type": media_type})

    if not saved:
        return 502, {"error": "OpenRouter's reply had no image data in it."}

    usage = payload.get("usage") or {}
    record = {"id": media_id, "kind": "image", "status": "completed", "prompt": prompt,
              "model": model, "params": {k: v for k, v in request_body.items()
                                         if k not in ("prompt", "model", "input_references")},
              "files": saved, "cost": usage.get("cost")}
    save_media(record)
    return 200, get_media(media_id)


# ---- videos: slow jobs that run on OpenRouter's side ----
# A video takes anywhere from half a minute to several minutes, so OpenRouter
# hands back a job id straight away. This program then checks on that job in the
# background, which is why closing the browser tab doesn't lose the video.
VIDEO_POLL_SECONDS = 10          # OpenRouter suggests 30; the plan asks for 10
VIDEO_MAX_POLLS = 360            # give up after about an hour
VIDEO_MAX_ERRORS = 5             # ... or after this many failed checks in a row

_video_models_cache = {"fetched_at": 0, "models": None}


def openrouter_video_models():
    """Every video model, with the durations, resolutions and prices it supports."""
    now = time.time()
    if _video_models_cache["models"] and now - _video_models_cache["fetched_at"] < MODELS_CACHE_SECONDS:
        return 200, {"models": _video_models_cache["models"], "cached": True}

    status, payload = openrouter_json("/videos/models", timeout=45)
    if status != 200 or not isinstance(payload.get("data"), list):
        if _video_models_cache["models"]:
            return 200, {"models": _video_models_cache["models"], "cached": True, "stale": True}
        return (status or 502), {"error": openrouter_error_text(payload, "Could not load the video models")}

    models = []
    for m in payload["data"]:
        models.append({
            "id": m.get("id"),
            "name": m.get("name") or m.get("id"),
            "durations": m.get("supported_durations") or [],
            "resolutions": m.get("supported_resolutions") or [],
            "aspect_ratios": m.get("supported_aspect_ratios") or [],
            "frame_images": m.get("supported_frame_images") or [],
            "generate_audio": m.get("generate_audio"),
            "pricing_skus": m.get("pricing_skus") or {},
        })
    models.sort(key=lambda m: (m["name"] or "").lower())
    _video_models_cache["models"] = models
    _video_models_cache["fetched_at"] = now
    return 200, {"models": models, "cached": False}


def update_media(media_id, **fields):
    sets, values = [], []
    for name, value in fields.items():
        if name in ("files", "params"):
            sets.append(("files_json" if name == "files" else "params_json") + " = ?")
            values.append(json.dumps(value))
        elif name in ("status", "cost", "error", "job_id"):
            sets.append(name + " = ?")
            values.append(value)
    if not sets:
        return
    sets.append("updated = ?")
    values.extend([int(time.time() * 1000), media_id])
    with _db_lock, _db:
        _db.execute("UPDATE media SET %s WHERE id = ?" % ", ".join(sets), values)


def openrouter_download(path, key, timeout=600):
    """Fetch a file (not JSON) from OpenRouter. Returns (status, bytes, content type)."""
    request = urllib.request.Request(OPENROUTER + path, headers={"Authorization": "Bearer " + key})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, response.read(), response.headers.get("Content-Type", "")
    except urllib.error.HTTPError as err:
        return err.code, b"", ""
    except Exception:
        return 0, b"", ""


def watch_video_job(media_id, job_id):
    """Check on one video job until it finishes, then save the file. Runs on its own thread."""
    errors = 0
    for _ in range(VIDEO_MAX_POLLS):
        time.sleep(VIDEO_POLL_SECONDS)
        key = load_settings()["openrouter_key"]       # read each time: it can be replaced
        if not key:
            update_media(media_id, status="failed", error="The OpenRouter key was removed.")
            return

        status, payload = openrouter_json("/videos/" + job_id, key=key, timeout=60)
        if status != 200:
            errors += 1
            if errors >= VIDEO_MAX_ERRORS:
                update_media(media_id, status="failed",
                             error=openrouter_error_text(payload, "Lost contact with the job."))
                return
            continue
        errors = 0

        state = payload.get("status")
        if state in ("pending", "in_progress"):
            update_media(media_id, status=state)
            continue

        if state == "completed":
            code, data, content_type = openrouter_download("/videos/%s/content?index=0" % job_id, key)
            if code != 200 or not data:
                update_media(media_id, status="failed",
                             error="The video finished but couldn't be downloaded (%s)." % code)
                return
            media_type = (content_type or "video/mp4").split(";")[0].strip()
            name = "%s_0.%s" % (media_id, MEDIA_EXTENSIONS.get(media_type, "mp4"))
            os.makedirs(MEDIA_DIRS["video"], exist_ok=True)
            try:
                with open(os.path.join(MEDIA_DIRS["video"], name), "wb") as f:
                    f.write(data)
            except OSError as err:
                update_media(media_id, status="failed", error="Could not save the video: %s" % err)
                return
            usage = payload.get("usage") or {}
            update_media(media_id, status="completed",
                         files=[{"name": name, "media_type": media_type}],
                         cost=usage.get("cost"), error=None)
            print("  Video finished and saved: %s" % name)
            return

        # failed, cancelled or expired - all final
        update_media(media_id, status=state or "failed",
                     error=openrouter_error_text(payload, "The job ended as '%s'." % state))
        return

    update_media(media_id, status="failed", error="Gave up waiting for this video.")


def start_watching(media_id, job_id):
    threading.Thread(target=watch_video_job, args=(media_id, job_id), daemon=True).start()


def resume_video_jobs():
    """After a restart, pick up any job that hadn't finished."""
    with _db_lock:
        rows = _db.execute(
            "SELECT id, job_id FROM media WHERE kind = 'video' AND status IN ('pending', 'in_progress')"
        ).fetchall()
    resumed = 0
    for row in rows:
        if row["job_id"]:
            start_watching(row["id"], row["job_id"])
            resumed += 1
        else:
            update_media(row["id"], status="failed", error="This job was lost when the app restarted.")
    if resumed:
        print("  Still waiting on %d video job(s) from last time." % resumed)


def start_video_job(body):
    key = load_settings()["openrouter_key"]
    if not key:
        return 400, {"error": "No OpenRouter key yet. Open Settings and connect."}

    model = (body.get("model") or "").strip()
    prompt = (body.get("prompt") or "").strip()
    if not model:
        return 400, {"error": "Pick a model first."}

    request_body = {"model": model}
    if prompt:
        request_body["prompt"] = prompt
    for name in ("resolution", "aspect_ratio", "size"):
        if body.get(name) not in (None, "", "auto"):
            request_body[name] = body[name]
    if body.get("duration"):
        try:
            request_body["duration"] = int(body["duration"])
        except (TypeError, ValueError):
            pass
    if isinstance(body.get("generate_audio"), bool):
        request_body["generate_audio"] = body["generate_audio"]
    frames = body.get("frame_images")
    if isinstance(frames, list) and frames:
        request_body["frame_images"] = frames[:2]

    status, payload = openrouter_json("/videos", key=key, body=request_body, timeout=120)
    if status not in (200, 202):
        return status, {"error": openrouter_error_text(payload, "Could not start the video")}
    job_id = payload.get("id")
    if not job_id:
        return 502, {"error": "OpenRouter didn't return a job id."}

    media_id = new_media_id()
    save_media({"id": media_id, "kind": "video", "status": payload.get("status") or "pending",
                "prompt": prompt, "model": model,
                "params": {k: v for k, v in request_body.items()
                           if k not in ("prompt", "model", "frame_images")},
                "files": [], "job_id": job_id})
    start_watching(media_id, job_id)
    return 200, get_media(media_id)


# ---- "Connect OpenRouter" sign-in (OAuth PKCE) ----
# PKCE (Proof Key for Code Exchange) means: we invent a secret, send only its
# fingerprint to OpenRouter, and prove we are the same app later by showing the
# secret itself. Nothing secret ever travels through the browser's address bar.
_pending_logins = {}            # state string -> {"verifier": ..., "expires": ...}
_pending_lock = threading.Lock()
LOGIN_MINUTES = 10


def start_login(origin):
    """Build the OpenRouter sign-in link for this app's address."""
    verifier = secrets.token_urlsafe(64)
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    challenge = base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")
    state = secrets.token_urlsafe(16)       # a random tag, sent back to us, so we know it is our login

    with _pending_lock:
        now = time.time()
        for old, info in list(_pending_logins.items()):      # tidy up abandoned attempts
            if info["expires"] < now:
                del _pending_logins[old]
        _pending_logins[state] = {"verifier": verifier, "expires": now + LOGIN_MINUTES * 60}

    query = urllib.parse.urlencode({
        "callback_url": origin + "/oauth/callback",
        "code_challenge": challenge,
        "code_challenge_method": "S256",
        "state": state,
        "key_label": "CharChat",
    })
    return OPENROUTER_AUTH + "?" + query


def finish_login(code, state):
    """Swap the one-time code for a real API key and save it. Returns an error message or None."""
    with _pending_lock:
        pending = _pending_logins.pop(state, None)
    if not pending:
        return "This sign-in link has expired or was already used. Please try Connect again."
    if pending["expires"] < time.time():
        return "The sign-in took too long. Please try Connect again."

    status, payload = openrouter_json("/auth/keys", body={
        "code": code,
        "code_verifier": pending["verifier"],
        "code_challenge_method": "S256",
    })
    key = payload.get("key") if isinstance(payload, dict) else None
    if status != 200 or not key:
        return openrouter_error_text(payload, "OpenRouter would not hand over a key (code %s)" % status)

    save_settings({"openrouter_key": key})
    return None


# ===========================================================================
# The web server
# ===========================================================================
class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=APP_DIR, **kwargs)

    # quieter console: only show API calls and errors
    def log_message(self, fmt, *args):
        if "/api/" in (self.path or "") or (args and str(args[1])[:1] in "45"):
            sys.stderr.write("  %s  %s\n" % (time.strftime("%H:%M:%S"), fmt % args))

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def parse_request(self):
        """Runs before every GET, POST, PUT, DELETE and HEAD: check the Host first."""
        if not super().parse_request():
            return False
        if host_allowed(self.headers.get("Host")):
            return True
        self._body_read = False
        self.discard_unread_body()
        self.send_error(403, "Unknown host name",
                        "Open CharChat through localhost or an IP address, or start it with "
                        "--allow-host <name> to allow this name.")
        return False

    def static_allowed(self):
        """Is this one of the plain files the page needs? Checks the real file that
        would be opened, after the address has been decoded and tidied up."""
        root = os.path.realpath(APP_DIR)
        real = os.path.realpath(self.translate_path(self.path))
        if os.path.normcase(real) == os.path.normcase(root):
            return True                                   # "/" -> index.html
        try:
            relative = os.path.relpath(real, root)
        except ValueError:                                # a different drive on Windows
            return False
        if not os.path.isfile(real):
            return False
        top = os.path.normcase(relative).split(os.sep)[0]
        return (os.path.normcase(relative) == "index.html" or top in PUBLIC_FOLDERS
                or bool(AVATAR_FILE.match(relative)))

    # ---------- every request goes through run_safely ----------
    def send_response(self, code, message=None):
        self._responded = True               # from here on, an error page can't be sent any more
        super().send_response(code, message)

    def run_safely(self, route):
        """Run one request. If something breaks, answer with a readable error
        instead of just dropping the connection (which the page could only
        report as "Failed to fetch"), and print the details in the console."""
        self._responded = False
        self._body_read = False
        try:
            route()
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass                             # the browser went away; nobody to tell
        except Exception:
            traceback.print_exc()
            if not self._responded:
                try:
                    self.send_json({"error": "Something went wrong inside CharChat. "
                                             "The details are in its console window."}, 500)
                except Exception:
                    pass
        finally:
            self.discard_unread_body()

    def discard_unread_body(self, limit=1024 * 1024):
        """Read and throw away a request body we never looked at (a refused request,
        say). On Windows, closing a connection that still has unread data in it
        makes the other side see "connection reset" instead of our answer."""
        if getattr(self, "_body_read", False):
            return
        self._body_read = True
        try:
            length = int(self.headers.get("Content-Length", 0))
        except (TypeError, ValueError):
            return
        if 0 < length <= limit:
            try:
                self.rfile.read(length)
            except OSError:
                pass

    def do_GET(self):
        self.run_safely(self.route_get)

    def do_HEAD(self):
        self.run_safely(self.route_head)

    def do_POST(self):
        self.run_safely(self.route_post)

    def do_PUT(self):
        self.run_safely(self.route_put)

    def do_DELETE(self):
        self.run_safely(self.route_delete)

    def route_head(self):
        if not self.static_allowed():
            return self.send_error(404)
        return super().do_HEAD()

    def send_json(self, data, status=200):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def redirect(self, location):
        self.send_response(302)
        self.send_header("Location", location)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def api_parts(self):
        path = urlparse(self.path).path
        if not path.startswith("/api/"):
            return None
        return [unquote(p) for p in path[5:].split("/") if p]

    def valid(self, *names):
        if all(SAFE.match(n or "") for n in names):
            return True
        self.send_json({"error": "invalid name"}, 400)
        return False

    def read_body(self, limit=32 * 1024 * 1024):
        self._body_read = True
        length = int(self.headers.get("Content-Length", 0))
        if length <= 0:
            return {}
        if length > limit:               # a reference image can be big, but not unlimited
            raise ValueError("body too large")
        return json.loads(self.rfile.read(length).decode("utf-8"))

    def query(self, name, default=""):
        values = urllib.parse.parse_qs(urlparse(self.path).query).get(name)
        return values[0] if values else default

    def send_file_bytes(self, path, content_type, download_name=None):
        try:
            with open(path, "rb") as f:
                data = f.read()
        except OSError:
            return self.send_json({"error": "not found"}, 404)
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        # These files came from outside (an image model, or a picture you pasted).
        # If one is opened on its own - an SVG, say - it may not run scripts or
        # act as part of this app, and the browser may not guess another type.
        self.send_header("Content-Security-Policy", "sandbox")
        self.send_header("X-Content-Type-Options", "nosniff")
        if download_name:
            self.send_header("Content-Disposition", 'attachment; filename="%s"' % download_name)
        self.end_headers()
        self.wfile.write(data)

    def from_our_page(self):
        """Only let our own page change things or spend credits.

        A web page on some other site can quietly send a plain request to
        http://localhost:8080/... in the background. It cannot add a custom
        header like this one, though: the browser refuses unless the other site
        is given permission first, which we never give. So this header is a
        simple proof that the request came from CharChat's own page.
        """
        if self.headers.get("X-CharChat") == "1":
            return True
        self.send_json({"error": "This request did not come from the CharChat page."}, 403)
        return False

    def md_target(self, parts):
        """Turn a URL like /api/md/character/nova/identity into a real file path.

        Only the fixed set of files can ever be reached from the web page; any
        other name is refused, so no stray files can be created or read.
        """
        if parts[:3] == ["md", "global", "user"]:
            return global_user_path(), "user.md"
        if parts[:2] == ["md", "character"] and len(parts) >= 4:
            name, kind = parts[2], parts[3]
            if SAFE.match(name) and kind in CHARACTER_FILES:
                return character_file_path(name, kind), "characters/%s/%s.md" % (name, kind)
        return None, None

    def origin_for_callback(self):
        """The address this browser used to reach us, e.g. http://localhost:8080."""
        host = self.headers.get("Host") or ("localhost:%d" % self.server.server_address[1])
        return "http://" + host

    # ---------- GET ----------
    def route_get(self):
        path = urlparse(self.path).path

        if path == "/oauth/callback":
            return self.handle_oauth_callback()

        parts = self.api_parts()
        if parts is None:
            if not self.static_allowed():             # data/, user.md, server.py ... never
                return self.send_json({"error": "not found"}, 404)
            return super().do_GET()                   # index.html, static/, lib/, assets/, avatars

        if parts == ["status"]:
            return self.send_json({"version": APP_VERSION, "lan": LAN_MODE,
                                   "connected": bool(load_settings()["openrouter_key"])})

        if parts == ["settings"]:
            return self.send_json(public_settings())

        if parts == ["characters"]:
            return self.send_json(list_characters())

        if len(parts) == 3 and parts[0] == "characters" and parts[2] == "info":
            if not self.valid(parts[1]):
                return
            return self.send_json(character_info(parts[1]))

        if len(parts) == 3 and parts[0] == "characters" and parts[2] == "system":
            if not self.valid(parts[1]):
                return
            prompt, source = compose_system_prompt(parts[1])
            return self.send_json({"prompt": prompt, "user_source": source})

        if parts[0] == "md":
            path, shown_as = self.md_target(parts)
            if not path:
                return self.send_json({"error": "unknown file"}, 404)
            return self.send_json(md_payload(path, shown_as))

        if parts == ["openrouter", "models"]:
            status, payload = openrouter_models()
            return self.send_json(payload, status)

        if parts == ["openrouter", "image-models"]:
            status, payload = openrouter_image_models()
            return self.send_json(payload, status)

        if parts == ["openrouter", "image-model"]:       # one model's prices and options
            model_id = self.query("id")
            if not model_id:
                return self.send_json({"error": "no model given"}, 400)
            status, payload = openrouter_image_model_detail(model_id)
            return self.send_json(payload, status)

        if len(parts) == 2 and parts[0] == "uploads":     # a picture attached to a message
            if not self.valid(parts[1]):
                return
            path = upload_path(parts[1])
            if not path:
                return self.send_json({"error": "not found"}, 404)
            extension = os.path.splitext(path)[1].lstrip(".")
            kind = next((t for t, e in UPLOAD_TYPES.items() if e == extension), "image/png")
            return self.send_file_bytes(path, kind)

        if parts == ["openrouter", "video-models"]:
            status, payload = openrouter_video_models()
            return self.send_json(payload, status)

        if parts == ["media"]:                           # the gallery list
            kind = self.query("kind", "image")
            if kind not in MEDIA_DIRS:
                return self.send_json({"error": "unknown kind"}, 400)
            return self.send_json(list_media(kind))

        if len(parts) == 3 and parts[0] == "media":      # one saved file
            media_id, index = parts[1], parts[2]
            if not self.valid(media_id) or not index.isdigit():
                return self.send_json({"error": "not found"}, 404)
            item = get_media(media_id)
            if not item or int(index) >= len(item["files"]):
                return self.send_json({"error": "not found"}, 404)
            entry = item["files"][int(index)]
            path = os.path.join(MEDIA_DIRS[item["kind"]], entry["name"])
            download = self.query("download") == "1"
            return self.send_file_bytes(path, entry.get("media_type") or "application/octet-stream",
                                        entry["name"] if download else None)

        if parts == ["openrouter", "test"]:
            key = load_settings()["openrouter_key"]
            if not key:
                return self.send_json({"ok": False, "error": "No key saved yet."}, 400)
            status, payload = openrouter_json("/key", key=key)
            if status != 200:
                return self.send_json({"ok": False, "error": openrouter_error_text(payload)}, 200)
            info = payload.get("data") or {}
            return self.send_json({"ok": True, "label": info.get("label"),
                                   "usage": info.get("usage"), "limit": info.get("limit"),
                                   "limit_remaining": info.get("limit_remaining")})

        if parts == ["openrouter", "connect"]:
            if not self.from_our_page():
                return
            return self.send_json({"url": start_login(self.origin_for_callback())})

        if len(parts) == 2 and parts[0] == "chats":   # the chat list of one character
            character = parts[1]
            if not self.valid(character):
                return
            return self.send_json(list_chats(character))

        if len(parts) == 3 and parts[0] == "chats":   # one full chat
            character, chat_id = parts[1], parts[2]
            if not self.valid(character, chat_id):
                return
            chat = load_chat(character, chat_id)
            if chat is None:
                return self.send_json({"error": "not found"}, 404)
            return self.send_json(chat)

        self.send_json({"error": "unknown endpoint"}, 404)

    # ---------- POST ----------
    def route_post(self):
        parts = self.api_parts()
        if not parts:
            return self.send_json({"error": "unknown endpoint"}, 404)
        if not self.from_our_page():
            return

        if parts == ["openrouter", "chat"]:
            return self.proxy_chat()

        if parts == ["uploads"]:                      # attach a picture to a message
            try:
                body = self.read_body()
            except Exception:
                return self.send_json({"error": "That picture was too big to send."}, 400)
            record, problem = save_upload((body or {}).get("image"))
            if problem:
                return self.send_json({"error": problem}, 400)
            return self.send_json(record)

        if parts == ["openrouter", "image"]:          # generate one or more images
            try:
                body = self.read_body()
            except Exception:
                return self.send_json({"error": "bad JSON"}, 400)
            if not isinstance(body, dict):
                return self.send_json({"error": "bad JSON"}, 400)
            status, payload = generate_images(body)
            return self.send_json(payload, status)

        if parts == ["openrouter", "video"]:          # start a video job
            try:
                body = self.read_body()
            except Exception:
                return self.send_json({"error": "bad JSON"}, 400)
            if not isinstance(body, dict):
                return self.send_json({"error": "bad JSON"}, 400)
            status, payload = start_video_job(body)
            return self.send_json(payload, status)

        if parts == ["characters"]:                     # make a new character
            try:
                body = self.read_body()
            except Exception:
                return self.send_json({"error": "bad JSON"}, 400)
            slug, problem = create_character(body.get("name") if isinstance(body, dict) else "")
            if problem:
                return self.send_json({"error": problem}, 400)
            return self.send_json({"id": slug})

        if parts[0] == "md" and parts[-1] == "undo":  # "Undo last save"
            path, shown_as = self.md_target(parts[:-1])
            if not path:
                return self.send_json({"error": "unknown file"}, 404)
            if undo_md(path) is None:
                return self.send_json({"error": "There is no earlier version of this file yet."}, 400)
            return self.send_json(md_payload(path, shown_as))

        self.send_json({"error": "unknown endpoint"}, 404)

    # ---------- PUT ----------
    def route_put(self):
        parts = self.api_parts()
        if not parts:
            return self.send_json({"error": "unknown endpoint"}, 404)
        if not self.from_our_page():
            return

        if parts == ["settings"]:
            try:
                body = self.read_body()
            except Exception:
                return self.send_json({"error": "bad JSON"}, 400)
            if not isinstance(body, dict):
                return self.send_json({"error": "bad JSON"}, 400)

            changes = {}
            if isinstance(body.get("model"), str) and body["model"].strip():
                changes["model"] = body["model"].strip()
            if isinstance(body.get("ollama_url"), str) and body["ollama_url"].strip():
                changes["ollama_url"] = body["ollama_url"].strip()
            if isinstance(body.get("ollama_num_ctx"), int) and body["ollama_num_ctx"] > 0:
                changes["ollama_num_ctx"] = body["ollama_num_ctx"]
            if isinstance(body.get("ollama_model"), str):   # may be empty: no model chosen yet
                changes["ollama_model"] = body["ollama_model"].strip()
            if isinstance(body.get("openrouter_tools"), list):
                changes["openrouter_tools"] = [t for t in body["openrouter_tools"] if t in SERVER_TOOLS]
            # A key is only ever set, never read back out.
            if isinstance(body.get("openrouter_key"), str) and body["openrouter_key"].strip():
                changes["openrouter_key"] = body["openrouter_key"].strip()
            save_settings(changes)
            return self.send_json(public_settings())

        if parts[0] == "md":                          # save one of the Markdown files
            path, shown_as = self.md_target(parts)
            if not path:
                return self.send_json({"error": "unknown file"}, 404)
            try:
                body = self.read_body()
            except Exception:
                return self.send_json({"error": "bad JSON"}, 400)
            content = body.get("content") if isinstance(body, dict) else None
            if not isinstance(content, str):
                return self.send_json({"error": "no text to save"}, 400)
            save_md(path, content)
            return self.send_json(md_payload(path, shown_as))

        if len(parts) == 3 and parts[0] == "characters" and parts[2] == "override":
            if not self.valid(parts[1]):
                return
            try:
                body = self.read_body()
            except Exception:
                return self.send_json({"error": "bad JSON"}, 400)
            set_character_override(parts[1], bool(body.get("on")) if isinstance(body, dict) else False)
            return self.send_json(character_info(parts[1]))

        if len(parts) == 3 and parts[0] == "characters" and parts[2] == "avatar":
            if not self.valid(parts[1]):
                return
            try:
                body = self.read_body(limit=8 * 1024 * 1024)
            except Exception:
                return self.send_json({"error": "bad JSON"}, 400)
            problem = save_avatar(parts[1], (body or {}).get("image"))
            if problem:
                return self.send_json({"error": problem}, 400)
            return self.send_json(character_info(parts[1]))

        if len(parts) == 3 and parts[0] == "chats":
            character, chat_id = parts[1], parts[2]
            if not self.valid(character, chat_id):
                return
            try:
                data = self.read_body()
            except Exception:
                return self.send_json({"error": "bad JSON"}, 400)
            if not isinstance(data, dict):
                return self.send_json({"error": "bad JSON"}, 400)
            save_chat(character, chat_id, data)         # the URL decides the id and character, not the body
            return self.send_json({"ok": True})

        self.send_json({"error": "unknown endpoint"}, 404)

    # ---------- DELETE ----------
    def route_delete(self):
        parts = self.api_parts()
        if not parts:
            return self.send_json({"error": "unknown endpoint"}, 404)
        if not self.from_our_page():
            return

        if parts == ["openrouter", "key"]:            # "Disconnect"
            save_settings({"openrouter_key": ""})
            return self.send_json(public_settings())

        if len(parts) == 3 and parts[0] == "characters" and parts[2] == "avatar":
            if not self.valid(parts[1]):
                return
            remove_avatar(parts[1])
            return self.send_json(character_info(parts[1]))

        if len(parts) == 2 and parts[0] == "media":
            media_id = parts[1]
            if not self.valid(media_id):
                return
            if not delete_media(media_id):
                return self.send_json({"error": "not found"}, 404)
            return self.send_json({"ok": True})

        if len(parts) == 2 and parts[0] == "characters":
            name = parts[1]
            if not self.valid(name):
                return
            existing = list_characters()
            if name not in existing:
                return self.send_json({"error": "not found"}, 404)
            if len(existing) <= 1:
                return self.send_json(
                    {"error": "This is your only character, so it can't be deleted. "
                              "Make another one first."}, 400)
            delete_character(name)
            return self.send_json({"ok": True})

        if len(parts) == 3 and parts[0] == "chats":
            character, chat_id = parts[1], parts[2]
            if not self.valid(character, chat_id):
                return
            delete_chat(character, chat_id)
            return self.send_json({"ok": True})

        self.send_json({"error": "unknown endpoint"}, 404)

    # ---------- the OpenRouter sign-in comes back here ----------
    def handle_oauth_callback(self):
        query = urllib.parse.parse_qs(urlparse(self.path).query)
        code = (query.get("code") or [""])[0]
        state = (query.get("state") or [""])[0]
        if not code:
            return self.redirect("/?connect_error=" + urllib.parse.quote(
                "OpenRouter did not send a sign-in code back. Did you cancel?"))
        error = finish_login(code, state)
        if error:
            return self.redirect("/?connect_error=" + urllib.parse.quote(error))
        print("  OpenRouter connected - the key is saved in data/settings.json")
        return self.redirect("/?connected=1")

    # ---------- pass a chat through to OpenRouter, streaming the reply back ----------
    def proxy_chat(self):
        """The browser sends the messages; we add the key and hand the reply straight back.

        The reply is copied through line by line as it arrives, so words still
        appear one at a time. If you press Stop, the browser drops the
        connection, writing fails here, and we close the OpenRouter request too -
        which stops you being charged for the rest of the answer.
        """
        try:
            body = self.read_body()
        except Exception:
            return self.send_json({"error": "bad JSON"}, 400)
        if not isinstance(body, dict):
            return self.send_json({"error": "bad JSON"}, 400)

        settings = load_settings()
        key = settings["openrouter_key"]
        if not key:
            return self.send_json({"error": "No OpenRouter key yet. Open Settings and connect."}, 400)

        body.pop("api_key", None)              # the browser never supplies a key
        body["stream"] = True

        # Let the model search, open links or check the time, if that was switched on.
        wanted = [SERVER_TOOLS[name] for name in settings["openrouter_tools"] if name in SERVER_TOOLS]
        if wanted and not body.get("tools"):
            body["tools"] = [{"type": kind} for kind in wanted]

        request = urllib.request.Request(
            OPENROUTER + "/chat/completions",
            data=json.dumps(body).encode("utf-8"),
            headers={"Authorization": "Bearer " + key,
                     "Content-Type": "application/json",
                     "Accept": "text/event-stream",
                     "X-Title": "CharChat"})
        try:
            upstream = urllib.request.urlopen(request, timeout=300)
        except urllib.error.HTTPError as err:
            try:
                payload = json.loads(err.read().decode("utf-8"))
            except Exception:
                payload = {}
            return self.send_json(
                {"error": openrouter_error_text(payload, "OpenRouter returned %d" % err.code)}, err.code)
        except Exception as err:
            return self.send_json({"error": "Could not reach OpenRouter: %s" % err}, 502)

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.end_headers()
        try:
            for line in upstream:              # one SSE line at a time, as it arrives
                self.wfile.write(line)
                self.wfile.flush()
        except Exception:
            pass                               # the browser went away (Stop, or the tab was closed)
        finally:
            upstream.close()                   # always let go of the OpenRouter connection


def list_characters():
    if not os.path.isdir(CHARACTERS_DIR):
        return []
    return sorted(
        name for name in os.listdir(CHARACTERS_DIR)
        if SAFE.match(name) and os.path.isfile(os.path.join(CHARACTERS_DIR, name, "identity.md"))
    )


def main():
    global LAN_MODE
    ap = argparse.ArgumentParser(description="CharChat server")
    ap.add_argument("--port", type=int, default=8080)
    ap.add_argument("--lan", action="store_true", help="allow other devices on your network to connect")
    ap.add_argument("--no-browser", action="store_true", help="don't open a browser tab")
    ap.add_argument("--allow-host", action="append", default=[], metavar="NAME",
                    help="also accept this host name, e.g. a Tailscale name (can be repeated)")
    args = ap.parse_args()

    LAN_MODE = args.lan
    EXTRA_HOST_NAMES.update(n.strip().lower().rstrip(".") for n in args.allow_host if n.strip())
    host = "0.0.0.0" if args.lan else "127.0.0.1"
    ensure_data_dirs()
    migrate_characters_folder()
    init_db()
    import_v3_chats()
    resume_video_jobs()      # pick up any video that was still being made

    try:
        server = ThreadingHTTPServer((host, args.port), Handler)
    except OSError:
        print(f"\n  Port {args.port} is already in use. Is CharChat already running?")
        print(f"  Try:  python server.py --port {args.port + 1}\n")
        sys.exit(1)

    url = f"http://localhost:{args.port}"
    print(f"\n  CharChat is running at {url}")
    if args.lan:
        print(f"  Other devices: http://<this-computer's-IP>:{args.port}")
        print("\n  !! WARNING: --lan is on and there is no password yet.")
        print("     Anyone on this network can use this app and your OpenRouter credits.")
        print("     Only use --lan on a private network such as Tailscale.")
        print("     Opening it by name (a Tailscale name, say)? Add:  --allow-host that-name\n")
    print(f"  Chats are saved in: {DB_PATH}")
    print("  Close this window (or press Ctrl+C) to stop.\n")
    if not args.no_browser:
        try:
            webbrowser.open(url)
        except Exception:
            pass
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n  Stopped.")


if __name__ == "__main__":
    main()
