/**
 * Extract Structured Text from TwinCAT XML files.
 *
 * TwinCAT stores ST code inside XML with CDATA sections:
 * - .TcPOU: POU Declaration + Implementation, plus child Method/Property/Action elements
 * - .TcGVL: Single Declaration CDATA (self-contained VAR_GLOBAL...END_VAR)
 * - .TcDUT: Single Declaration CDATA (self-contained TYPE...END_TYPE)
 *
 * For POUs, the closing keywords (END_FUNCTION_BLOCK, END_METHOD, etc.) are implied
 * by the XML structure and must be synthesized for tree-sitter to parse correctly.
 *
 * Ported from RooCode/src/services/code-index/processors/parser.ts
 */
export function extractStFromXml(xmlContent: string): string {
	const blocks: string[] = [];

	// Helper: extract CDATA content from an XML string fragment
	const extractCdata = (xml: string): string => {
		const match = /<!\[CDATA\[([\s\S]*?)\]\]>/.exec(xml);
		return match ? match[1].trim() : "";
	};

	// Helper: extract content between <Declaration>...</Declaration>
	const extractDeclaration = (xml: string): string => {
		const match = /<Declaration>([\s\S]*?)<\/Declaration>/.exec(xml);
		return match ? extractCdata(match[1]) : "";
	};

	// Helper: extract content between <Implementation><ST>...</ST></Implementation>
	const extractImplementation = (xml: string): string => {
		const match = /<Implementation>\s*<ST>([\s\S]*?)<\/ST>\s*<\/Implementation>/.exec(xml);
		return match ? extractCdata(match[1]) : "";
	};

	// Detect POU type from Declaration to synthesize the correct END keyword
	const detectEndKeyword = (declaration: string): string => {
		const upper = declaration.toUpperCase();
		if (upper.match(/\bFUNCTION_BLOCK\b/)) return "END_FUNCTION_BLOCK";
		if (upper.match(/\bPROGRAM\b/)) return "END_PROGRAM";
		if (upper.match(/\bFUNCTION\b/)) return "END_FUNCTION";
		return "";
	};

	// Check if this is a POU file (has <POU> element)
	const pouMatch = /<POU\b[^>]*>([\s\S]*)<\/POU>/i.exec(xmlContent);
	if (pouMatch) {
		const pouContent = pouMatch[1];

		// Extract main POU Declaration + Implementation
		const pouDecl = extractDeclaration(pouContent);
		const pouImpl = extractImplementation(pouContent);
		const endKeyword = detectEndKeyword(pouDecl);

		// Build the main POU block
		const pouParts: string[] = [];
		if (pouDecl) pouParts.push(pouDecl);
		if (pouImpl) pouParts.push(pouImpl);
		if (endKeyword) pouParts.push(endKeyword);
		if (pouParts.length > 0) blocks.push(pouParts.join("\n"));

		// Extract Methods
		const methodRegex = /<Method\b[^>]*>([\s\S]*?)<\/Method>/gi;
		let methodMatch: RegExpExecArray | null;
		while ((methodMatch = methodRegex.exec(pouContent)) !== null) {
			const methodDecl = extractDeclaration(methodMatch[1]);
			const methodImpl = extractImplementation(methodMatch[1]);
			const parts: string[] = [];
			if (methodDecl) parts.push(methodDecl);
			if (methodImpl) parts.push(methodImpl);
			parts.push("END_METHOD");
			blocks.push(parts.join("\n"));
		}

		// Extract Properties
		const propertyRegex = /<Property\b[^>]*>([\s\S]*?)<\/Property>/gi;
		let propMatch: RegExpExecArray | null;
		while ((propMatch = propertyRegex.exec(pouContent)) !== null) {
			const propDecl = extractDeclaration(propMatch[1]);
			const parts: string[] = [];
			if (propDecl) parts.push(propDecl);

			// Extract Get accessor
			const getMatch = /<Get\b[^>]*>([\s\S]*?)<\/Get>/i.exec(propMatch[1]);
			if (getMatch) {
				const getDecl = extractDeclaration(getMatch[1]);
				const getImpl = extractImplementation(getMatch[1]);
				parts.push("GET");
				if (getDecl) parts.push(getDecl);
				if (getImpl) parts.push(getImpl);
				parts.push("END_GET");
			}

			// Extract Set accessor
			const setMatch = /<Set\b[^>]*>([\s\S]*?)<\/Set>/i.exec(propMatch[1]);
			if (setMatch) {
				const setDecl = extractDeclaration(setMatch[1]);
				const setImpl = extractImplementation(setMatch[1]);
				parts.push("SET");
				if (setDecl) parts.push(setDecl);
				if (setImpl) parts.push(setImpl);
				parts.push("END_SET");
			}

			parts.push("END_PROPERTY");
			blocks.push(parts.join("\n"));
		}

		// Extract Actions
		const actionRegex = /<Action\b[^>]*>([\s\S]*?)<\/Action>/gi;
		let actionMatch: RegExpExecArray | null;
		while ((actionMatch = actionRegex.exec(pouContent)) !== null) {
			const actionName = /Name="([^"]*)"/.exec(actionMatch[0]);
			const actionImpl = extractImplementation(actionMatch[1]);
			const parts: string[] = [];
			if (actionName) parts.push(`ACTION ${actionName[1]} :`);
			if (actionImpl) parts.push(actionImpl);
			parts.push("END_ACTION");
			blocks.push(parts.join("\n"));
		}

		return blocks.join("\n\n");
	}

	// Interface files (.TcIO): Itf Declaration + child Method/Property declarations
	const itfMatch = /<Itf\b[^>]*>([\s\S]*)<\/Itf>/i.exec(xmlContent);
	if (itfMatch) {
		const itfContent = itfMatch[1];
		const itfDecl = extractDeclaration(itfContent);
		if (itfDecl) blocks.push(itfDecl);

		// Extract Method declarations (interface methods have no Implementation)
		const methodRegex = /<Method\b[^>]*>([\s\S]*?)<\/Method>/gi;
		let methodMatch: RegExpExecArray | null;
		while ((methodMatch = methodRegex.exec(itfContent)) !== null) {
			const methodDecl = extractDeclaration(methodMatch[1]);
			if (methodDecl) {
				blocks.push(methodDecl + "\nEND_METHOD");
			}
		}

		// Extract Property declarations
		const propertyRegex = /<Property\b[^>]*>([\s\S]*?)<\/Property>/gi;
		let propMatch: RegExpExecArray | null;
		while ((propMatch = propertyRegex.exec(itfContent)) !== null) {
			const propDecl = extractDeclaration(propMatch[1]);
			if (propDecl) {
				blocks.push(propDecl + "\nEND_PROPERTY");
			}
		}

		return blocks.join("\n\n");
	}

	// GVL and DUT files: single Declaration CDATA, already self-contained
	const gvlMatch = /<GVL\b[^>]*>([\s\S]*?)<\/GVL>/i.exec(xmlContent);
	if (gvlMatch) {
		const decl = extractDeclaration(gvlMatch[1]);
		if (decl) return decl;
	}

	const dutMatch = /<DUT\b[^>]*>([\s\S]*?)<\/DUT>/i.exec(xmlContent);
	if (dutMatch) {
		const decl = extractDeclaration(dutMatch[1]);
		if (decl) return decl;
	}

	// Fallback: extract all CDATA blocks (unknown XML structure)
	const cdataRegex = /<!\[CDATA\[([\s\S]*?)\]\]>/g;
	let fallbackMatch: RegExpExecArray | null;
	while ((fallbackMatch = cdataRegex.exec(xmlContent)) !== null) {
		const text = fallbackMatch[1].trim();
		if (text.length > 0) {
			blocks.push(text);
		}
	}
	return blocks.join("\n\n");
}
