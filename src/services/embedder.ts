import OpenAI from "openai";
import { EMBEDDING_MODEL, EMBEDDING_BATCH_SIZE, VECTOR_SIZE } from "../utils/constants.js";

const client = new OpenAI(); // Uses OPENAI_API_KEY env var

/**
 * Embed an array of text strings using OpenAI embeddings API.
 * Automatically batches to stay within API limits.
 * Returns one embedding vector per input text.
 */
export async function embedTexts(texts: string[]): Promise<number[][]> {
	const allEmbeddings: number[][] = [];

	for (let i = 0; i < texts.length; i += EMBEDDING_BATCH_SIZE) {
		const batch = texts.slice(i, i + EMBEDDING_BATCH_SIZE);
		const response = await client.embeddings.create({
			model: EMBEDDING_MODEL,
			input: batch,
		});
		// Response data is ordered by index — sort to be safe
		const sorted = response.data.sort((a, b) => a.index - b.index);

		// Validate dimension on first batch
		if (i === 0 && sorted.length > 0) {
			const dim = sorted[0].embedding.length;
			if (dim !== VECTOR_SIZE) {
				throw new Error(
					`Embedding dimension mismatch: model "${EMBEDDING_MODEL}" returned ${dim}-dim vectors, but VECTOR_SIZE is ${VECTOR_SIZE}. ` +
					`Set VECTOR_SIZE=${dim} or change OPENAI_EMBEDDING_MODEL.`
				);
			}
		}

		for (const item of sorted) {
			allEmbeddings.push(item.embedding);
		}
	}

	return allEmbeddings;
}

/**
 * Embed a single query string.
 */
export async function embedQuery(query: string): Promise<number[]> {
	const [embedding] = await embedTexts([query]);
	return embedding;
}
