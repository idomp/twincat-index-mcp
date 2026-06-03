/** TwinCAT file extensions recognized by the scanner (case-insensitive matching). */
export const TWINCAT_EXTENSIONS = ["TcPOU", "TcGVL", "TcDUT", "st", "TcVIS", "TcTLO", "TcGTLO", "TcVMO", "TcIO"];

/** Glob pattern for fast-glob. */
export const TWINCAT_GLOB = `**/*.{${TWINCAT_EXTENSIONS.join(",")}}`;

/** Directories excluded from scanning. */
export const IGNORE_PATTERNS = [
	"**/_Build/**",
	"**/_CompileInfo/**",
	"**/node_modules/**",
	"**/.git/**",
];

/** Extensions that contain XML-wrapped ST code (need CDATA extraction). */
export const XML_EXTENSIONS = new Set(["tcpou", "tcgvl", "tcdut", "tcio"]);

/** Extensions that contain HMI visualization content (need HMI extraction, no tree-sitter). */
export const HMI_EXTENSIONS = new Set(["tcvis", "tctlo", "tcgtlo", "tcvmo"]);

/** Minimum chunk size in characters — smaller chunks are discarded. */
export const MIN_CHUNK_CHARS = 50;

/** Maximum chunk size in characters — larger chunks get split further. */
export const MAX_CHUNK_CHARS = 8000;

/** Fallback chunk target size for line-based splitting. */
export const FALLBACK_CHUNK_TARGET = 2000;

/** OpenAI embedding model. */
export const EMBEDDING_MODEL = process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small";

/** Embedding vector dimensions — must match the chosen embedding model. */
export const VECTOR_SIZE = parseInt(process.env.VECTOR_SIZE || "1536", 10);

/** Qdrant server URL. */
export const QDRANT_URL = process.env.QDRANT_URL || "http://localhost:6333";

/** Maximum texts per OpenAI embedding request. */
export const EMBEDDING_BATCH_SIZE = 100;
