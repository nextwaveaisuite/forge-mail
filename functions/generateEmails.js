// functions/generateEmails.js
// Forge Mail — Email generation engine
// Generates 10 subject lines + 5 email bodies from any affiliate URL
// Each email uses a distinct psychological framework

const HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
};

// The 10 psychological frameworks — one per subject line style
// 5 of these also map to email body styles
const FRAMEWORKS = [
  {
    id: "curiosity_gap",
    name: "Curiosity Gap",
    description: "Opens a loop they must close by clicking",
    subjectStyle: "Tease something without revealing it",
    bodyStyle: "Open with a question or incomplete story, build tension, resolve only with the link",
  },
  {
    id: "fomo",
    name: "FOMO",
    description: "Fear of missing out — others are already in",
    subjectStyle: "Imply others are already benefiting",
    bodyStyle: "Paint a picture of what they're missing while they wait, make the link feel like the door everyone else walked through",
  },
  {
    id: "pain_agitation",
    name: "Pain Agitation",
    description: "Poke the exact problem, then offer the exit",
    subjectStyle: "Name the pain directly",
    bodyStyle: "Two sentences on the pain. One sentence making it worse. One sentence that the link is the way out.",
  },
  {
    id: "social_proof",
    name: "Social Proof",
    description: "Others are getting results — they can too",
    subjectStyle: "Reference results others are getting",
    bodyStyle: "Imply or state that real people are using this and winning. Link is how they join them.",
  },
  {
    id: "pattern_interrupt",
    name: "Pattern Interrupt",
    description: "Starts unexpectedly — breaks their scroll trance",
    subjectStyle: "Say something unexpected or counterintuitive",
    bodyStyle: "Open with a bold or strange statement that stops them cold. Pivot to the offer naturally.",
  },
  {
    id: "authority",
    name: "Authority",
    description: "Positions the offer as expert-level solution",
    subjectStyle: "Reference expertise, discovery, or insider knowledge",
    bodyStyle: "Frame as something only those in the know have access to. Link feels exclusive.",
  },
  {
    id: "scarcity",
    name: "Scarcity",
    description: "Creates urgency without being fake",
    subjectStyle: "Time or availability pressure",
    bodyStyle: "Brief, specific reason why now matters. Not fake countdown — real reason to act today.",
  },
  {
    id: "story_hook",
    name: "Story Hook",
    description: "One-line story that pulls them into the email",
    subjectStyle: "Start a story in the subject line",
    bodyStyle: "Two-sentence story setup. One pivot sentence. Link as the natural next step.",
  },
  {
    id: "direct_challenge",
    name: "Direct Challenge",
    description: "Calls the reader out — challenges their belief",
    subjectStyle: "Challenge or provoke their current thinking",
    bodyStyle: "Challenge a belief they hold. Show them what's actually possible. Link proves it.",
  },
  {
    id: "reverse_psychology",
    name: "Reverse Psychology",
    description: "This probably isn't for you...",
    subjectStyle: "Disqualify most readers — makes them want to qualify",
    bodyStyle: "Tell them this isn't for everyone. Describe who it IS for in a way that makes them self-identify. Link feels earned.",
  },
];

// The 5 body frameworks used for email bodies (selected from above)
const BODY_FRAMEWORKS = [
  FRAMEWORKS[0], // curiosity_gap
  FRAMEWORKS[2], // pain_agitation
  FRAMEWORKS[4], // pattern_interrupt
  FRAMEWORKS[7], // story_hook
  FRAMEWORKS[9], // reverse_psychology
];

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: HEADERS, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers: HEADERS, body: "Method not allowed" };

  try {
    const { affiliateUrl, niche, customNote } = JSON.parse(event.body || "{}");

    if (!affiliateUrl) {
      return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: "affiliateUrl is required" }) };
    }

    const nicheContext = niche ? `The offer is in the "${niche}" niche.` : "";
    const noteContext = customNote ? `Additional context: ${customNote}` : "";

    const prompt = `You are a world-class direct response email copywriter specialising in affiliate marketing email campaigns.

AFFILIATE URL: ${affiliateUrl}
${nicheContext}
${noteContext}

Your job is to write cold email copy for a list of 15,600 leads on the My Lead Gen Secret platform.
These are cold leads — they don't know the sender personally.

RULES FOR ALL COPY:
- Every email must be UNDER 150 WORDS — MLGS cold email format
- Write in plain conversational English — no hype, no ALL CAPS sentences
- Include [YOUR LINK] as a placeholder wherever the affiliate link goes
- One call to action per email — always [YOUR LINK]
- No unsubscribe text, no legal disclaimers — the platform handles that
- Sound like a real person writing to a friend, not a marketer
- Never use the word "spam" or reference email marketing
- Subject lines: under 50 characters, no clickbait, no excessive punctuation

PSYCHOLOGICAL FRAMEWORKS TO USE:

For subject lines, write one for EACH of these 10 frameworks:
1. Curiosity Gap — tease without revealing
2. FOMO — others are already in
3. Pain Agitation — name the pain directly
4. Social Proof — results others are getting
5. Pattern Interrupt — unexpected/counterintuitive opening
6. Authority — insider/expert knowledge angle
7. Scarcity — time or availability pressure
8. Story Hook — start a story in the subject
9. Direct Challenge — challenge their current belief
10. Reverse Psychology — "this probably isn't for you"

For email bodies, write one using EACH of these 5 frameworks:
1. Curiosity Gap
2. Pain Agitation
3. Pattern Interrupt
4. Story Hook
5. Reverse Psychology

Return ONLY valid JSON — no markdown, no code fences:

{
  "offerContext": "one sentence describing what this offer appears to be about based on the URL",
  "niche": "detected or provided niche",
  "subjectLines": [
    { "id": 1, "framework": "Curiosity Gap",      "subject": "...", "previewText": "one line preview text under 60 chars" },
    { "id": 2, "framework": "FOMO",               "subject": "...", "previewText": "..." },
    { "id": 3, "framework": "Pain Agitation",     "subject": "...", "previewText": "..." },
    { "id": 4, "framework": "Social Proof",       "subject": "...", "previewText": "..." },
    { "id": 5, "framework": "Pattern Interrupt",  "subject": "...", "previewText": "..." },
    { "id": 6, "framework": "Authority",          "subject": "...", "previewText": "..." },
    { "id": 7, "framework": "Scarcity",           "subject": "...", "previewText": "..." },
    { "id": 8, "framework": "Story Hook",         "subject": "...", "previewText": "..." },
    { "id": 9, "framework": "Direct Challenge",   "subject": "...", "previewText": "..." },
    { "id": 10,"framework": "Reverse Psychology", "subject": "...", "previewText": "..." }
  ],
  "emailBodies": [
    {
      "id": 1,
      "framework": "Curiosity Gap",
      "psychHook": "one sentence explaining the psychological mechanic used",
      "wordCount": 0,
      "body": "full email body text — plain text, under 150 words, includes [YOUR LINK]"
    },
    {
      "id": 2,
      "framework": "Pain Agitation",
      "psychHook": "...",
      "wordCount": 0,
      "body": "..."
    },
    {
      "id": 3,
      "framework": "Pattern Interrupt",
      "psychHook": "...",
      "wordCount": 0,
      "body": "..."
    },
    {
      "id": 4,
      "framework": "Story Hook",
      "psychHook": "...",
      "wordCount": 0,
      "body": "..."
    },
    {
      "id": 5,
      "framework": "Reverse Psychology",
      "psychHook": "...",
      "wordCount": 0,
      "body": "..."
    }
  ]
}`;

    const aiRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.85,
      }),
    });

    const aiData = await aiRes.json();
    const raw = aiData.choices?.[0]?.message?.content;
    if (!raw) throw new Error("No response from OpenAI");

    const clean = raw.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    const result = JSON.parse(clean);

    // Calculate word counts
    result.emailBodies = result.emailBodies.map(e => ({
      ...e,
      wordCount: e.body.split(/\s+/).filter(Boolean).length,
    }));

    // Build all 50 combinations for the rotator
    const combinations = [];
    let combId = 1;
    result.subjectLines.forEach(s => {
      result.emailBodies.forEach(b => {
        combinations.push({
          id: combId++,
          subjectId: s.id,
          bodyId: b.id,
          subject: s.subject,
          framework: `${s.framework} / ${b.framework}`,
          sent: false,
          sentDate: null,
        });
      });
    });

    return {
      statusCode: 200,
      headers: HEADERS,
      body: JSON.stringify({
        ...result,
        affiliateUrl,
        combinations,
        totalCombinations: combinations.length,
        generatedAt: new Date().toISOString(),
      }),
    };

  } catch (err) {
    console.error("[generateEmails]", err);
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: err.message }) };
  }
};
