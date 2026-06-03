/**
 * HMI extraction logic for TwinCAT visualization files (.TcVIS, .TcTLO, .TcGTLO, .TcVMO).
 *
 * All extraction uses regex — no XML parser dependencies.
 */

import { MIN_CHUNK_CHARS, MAX_CHUNK_CHARS } from "../utils/constants.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A chunk produced from an HMI visualization file. Structurally identical to CodeChunk. */
export interface HmiChunk {
	name: string;
	type: string;
	content: string;
	startLine: number;
	endLine: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Decode the five standard XML/HTML character-entity references. */
function decodeEntities(text: string): string {
	return text
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&amp;/g, "&")
		.replace(/&apos;/g, "'")
		.replace(/&quot;/g, '"');
}

// ---------------------------------------------------------------------------
// TcTLO / TcGTLO — Text Lists
// ---------------------------------------------------------------------------

/**
 * Extract text-list entries from a TcTLO or TcGTLO file.
 *
 * Each file contains a single `<TextList>` or `<GlobalTextList>` element with
 * many TextID / TextDefault value pairs encoded as `<v>` elements.
 */
export function extractTextList(xmlContent: string, fileName: string): HmiChunk[] {
	const lineCount = xmlContent.split("\n").length;

	// Determine list name
	const nameMatch = xmlContent.match(/<(?:TextList|GlobalTextList)\s[^>]*Name="([^"]+)"/);
	const listName = nameMatch ? nameMatch[1] : fileName.replace(/\.[^.]+$/, "");

	// Extract TextID→TextDefault pairs.
	// Pattern: <v n="TextID">"value"</v>  …whitespace…  <v n="TextDefault">"value"</v>
	const pairRegex =
		/<v\s+n="TextID">"([^"]*)"<\/v>\s*<v\s+n="TextDefault">"([^"]*)"<\/v>/g;

	const entries: Array<{ id: string; text: string }> = [];
	let pairMatch: RegExpExecArray | null;
	while ((pairMatch = pairRegex.exec(xmlContent)) !== null) {
		const id = pairMatch[1];
		const text = pairMatch[2];
		// Skip entries where both fields are empty
		if (id === "" && text === "") continue;
		entries.push({ id, text: decodeEntities(text) });
	}

	if (entries.length === 0) return [];

	// Build chunks, splitting when the accumulated text would exceed MAX_CHUNK_CHARS.
	const header = `TextList: ${listName}\nEntries:`;
	const chunks: HmiChunk[] = [];
	let currentLines: string[] = [];
	let currentSize = header.length;

	const flush = () => {
		if (currentLines.length === 0) return;
		const body = `${header}\n${currentLines.join("\n")}`;
		chunks.push({
			name: listName,
			type: "text_list",
			content: body,
			startLine: 1,
			endLine: lineCount,
		});
		currentLines = [];
		currentSize = header.length;
	};

	for (const entry of entries) {
		const line = `  ${entry.id}: ${entry.text}`;
		if (currentSize + line.length + 1 > MAX_CHUNK_CHARS && currentLines.length > 0) {
			flush();
		}
		currentLines.push(line);
		currentSize += line.length + 1; // +1 for newline
	}
	flush();

	return chunks;
}

// ---------------------------------------------------------------------------
// TcVIS — Visualizations
// ---------------------------------------------------------------------------

/** Constants excluded from PLC-variable heuristic. */
const EXCLUDED_VALUES = new Set([
	"HCENTER",
	"VCENTER",
	"LEFT",
	"RIGHT",
	"TOP",
	"BOTTOM",
	"NONE",
	"Arial",
	"true",
	"false",
]);

/** Return true if `val` looks like a PLC variable reference. */
function isPlcVarRef(val: string): boolean {
	// Must start with letter or underscore
	if (!/^[A-Za-z_]/.test(val)) return false;
	// Must contain at least one dot-separated segment
	if (!/\./.test(val)) return false;
	// Reject values with spaces — these are boolean expressions, not variable paths
	if (/\s/.test(val)) return false;
	// Exclude known constants
	if (EXCLUDED_VALUES.has(val)) return false;
	// Exclude pure numbers (with optional U/L suffix)
	if (/^\d+[UuLl]*$/.test(val)) return false;
	return true;
}

/**
 * Extract chunks from a TcVIS (visualization screen) file.
 *
 * Produces:
 * - One "visualization" summary chunk per file.
 * - One "visualization_action" chunk per STSnippet action.
 */
export function extractFromTcVIS(xmlContent: string, fileName: string): HmiChunk[] {
	const lineCount = xmlContent.split("\n").length;
	const chunks: HmiChunk[] = [];

	// --- Screen name ---
	const visuNameMatch = xmlContent.match(/<Visu\s[^>]*Name="([^"]+)"/);
	const visuName = visuNameMatch ? visuNameMatch[1] : fileName.replace(/\.[^.]+$/, "");

	// --- VAR interface (TextDocument between <o n="TextDocument"> and GvlCreated) ---
	let varInterface = "";
	const textDocBlock = xmlContent.match(
		/<o\s+n="TextDocument"[\s\S]*?<\/o>\s*<v\s+n="GvlCreated"/
	);
	if (textDocBlock) {
		const textLines: string[] = [];
		const textLineRegex = /<v\s+n="Text">"([^"]*)"<\/v>/g;
		let tlMatch: RegExpExecArray | null;
		while ((tlMatch = textLineRegex.exec(textDocBlock[0])) !== null) {
			const line = decodeEntities(tlMatch[1]);
			if (line.trim()) textLines.push(line);
		}
		varInterface = textLines.join("\n");
	}

	// --- Element types ---
	const elementTypeRegex = /<v\s+n="VisualElementTypeName">"([^"]+)"<\/v>/g;
	const elementCounts = new Map<string, number>();
	let etMatch: RegExpExecArray | null;
	while ((etMatch = elementTypeRegex.exec(xmlContent)) !== null) {
		const typeName = etMatch[1];
		elementCounts.set(typeName, (elementCounts.get(typeName) || 0) + 1);
	}

	// --- PLC variable references ---
	const valueRegex = /<v\s+n="Value">"([^"]+)"<\/v>/g;
	const plcVars = new Set<string>();
	let valMatch: RegExpExecArray | null;
	while ((valMatch = valueRegex.exec(xmlContent)) !== null) {
		const raw = decodeEntities(valMatch[1]).trim();
		if (isPlcVarRef(raw)) {
			// Clean single variable path
			plcVars.add(raw);
		} else if (/\s/.test(raw) && /[A-Za-z_]\w*\.\w+/.test(raw)) {
			// Expression containing spaces (e.g., boolean condition) — extract
			// individual dotted-path identifiers from within it.
			const identRegex = /[A-Za-z_]\w*(?:\.\w+)+/g;
			let idMatch: RegExpExecArray | null;
			while ((idMatch = identRegex.exec(raw)) !== null) {
				const token = idMatch[0];
				if (!EXCLUDED_VALUES.has(token)) {
					plcVars.add(token);
				}
			}
		}
	}

	// --- STSnippet actions ---
	// Locate VisualElementInputActions blocks and extract event + code pairs.
	const actionBlockRegex =
		/<d\s+n="VisualElementInputActions"[^>]*>[\s\S]*?<\/d>/g;
	const actionChunks: HmiChunk[] = [];
	const actionSummaries: string[] = [];

	let abMatch: RegExpExecArray | null;
	while ((abMatch = actionBlockRegex.exec(xmlContent)) !== null) {
		const block = abMatch[0];

		// Event name — first <v> child that is not an attribute
		const eventMatch = block.match(/<v>([^<]+)<\/v>/);
		const eventName = eventMatch ? eventMatch[1] : "Unknown";

		// ST code
		const snippetMatch = block.match(/<v\s+n="STSnippet">"([\s\S]*?)"<\/v>/);
		if (!snippetMatch) continue;
		const code = decodeEntities(snippetMatch[1]).trim();
		if (code.length === 0) continue;

		actionSummaries.push(`  ${eventName}: ${code.split("\n").length} lines`);

		const actionContent = `Screen: ${visuName}\nEvent: ${eventName}\nST Code:\n${code}`;
		if (actionContent.length >= MIN_CHUNK_CHARS) {
			actionChunks.push({
				name: `${visuName}::${eventName}`,
				type: "visualization_action",
				content: actionContent,
				startLine: 1,
				endLine: lineCount,
			});
		}
	}

	// --- Build summary chunk ---
	const parts: string[] = [`Screen: ${visuName}`];

	if (varInterface) {
		parts.push(`\nVAR Interface:\n${varInterface}`);
	}

	if (elementCounts.size > 0) {
		const sorted = [...elementCounts.entries()].sort((a, b) => b[1] - a[1]);
		parts.push(
			`\nElement Types:\n${sorted.map(([t, c]) => `  ${t}: ${c}`).join("\n")}`
		);
	}

	if (plcVars.size > 0) {
		parts.push(
			`\nPLC Variable References:\n${[...plcVars].sort().map((v) => `  ${v}`).join("\n")}`
		);
	}

	if (actionSummaries.length > 0) {
		parts.push(`\nActions:\n${actionSummaries.join("\n")}`);
	}

	const summaryContent = parts.join("\n");
	if (summaryContent.length >= MIN_CHUNK_CHARS) {
		chunks.push({
			name: visuName,
			type: "visualization",
			content: summaryContent,
			startLine: 1,
			endLine: lineCount,
		});
	}

	chunks.push(...actionChunks);
	return chunks;
}

// ---------------------------------------------------------------------------
// TcVMO — Visualization Manager
// ---------------------------------------------------------------------------

/**
 * Extract the start-visualization entry from a TcVMO file.
 */
export function extractFromTcVMO(xmlContent: string, fileName: string): HmiChunk[] {
	const lineCount = xmlContent.split("\n").length;

	// TwinCAT uses either "StartVisualization" or "StartVisu33" depending on version.
	const startMatch = xmlContent.match(/<v\s+n="(?:StartVisualization|StartVisu33)">"([^"]+)"<\/v>/);
	if (!startMatch) return [];

	const startName = startMatch[1];
	const content = `Visualization Manager\nStart Screen: ${startName}`;

	return [
		{
			name: "VisualizationManager",
			type: "visu_manager",
			content,
			startLine: 1,
			endLine: lineCount,
		},
	];
}
