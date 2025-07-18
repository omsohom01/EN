import { type NextRequest, NextResponse } from "next/server";
import axios, { AxiosError } from "axios"; // Import AxiosError for type guard

// Load environment variables
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";

export async function POST(request: NextRequest) {
  try {
    console.log("Starting file analysis...");

    // Parse the form data
    const formData = await request.formData();
    const file = formData.get("file") as File | null;

    // Check if file exists
    if (!file) {
      console.error("No file provided");
      return NextResponse.json(
        {
          success: false,
          error: "No file provided",
        },
        { status: 400 }
      );
    }

    console.log(`File received: ${file.name}, type: ${file.type}, size: ${file.size} bytes`);

    // Check file type
    const isImage = file.type.startsWith("image/");
    const isPDF = file.type === "application/pdf";

    if (!isImage && !isPDF) {
      console.error(`Unsupported file type: ${file.type}`);
      return NextResponse.json(
        {
          success: false,
          error: "Only image and PDF files are supported",
        },
        { status: 400 }
      );
    }

    // Convert file to base64
    let fileBase64: string;
    try {
      const bytes = await file.arrayBuffer();
      const buffer = Buffer.from(bytes);
      fileBase64 = buffer.toString("base64");
      console.log(`File converted to base64, length: ${fileBase64.length} characters`);
    } catch (error) {
      console.error("Error converting file to base64:", error);
      return NextResponse.json(
        {
          success: false,
          error: "Failed to process file",
        },
        { status: 400 }
      );
    }

    // Use Groq API to analyze the content and generate questions
    try {
      console.log("Sending data to Groq API for analysis...");

      // Check if API key is available
      if (!GROQ_API_KEY) {
        console.error("GROQ_API_KEY is not set in environment variables");
        return NextResponse.json(
          {
            success: false,
            error: "Server configuration error",
          },
          { status: 500 }
        );
      }

      const marksRaw = formData.get("marks");
      const marks = marksRaw ? Number(marksRaw) : 1;

      const prompt = `You are an expert educator tasked with analyzing educational content from a provided ${isImage ? "image" : "PDF document"}.

Document details:
- Name: ${file.name}
- Type: ${file.type}
- Size: ${file.size} bytes

Your objective is to:
1. Assume the content of the document is educational material related to the filename.
2. Generate exactly 10 questions based on the likely content of this document (infer from the filename if direct content analysis isn't possible).
3. The questions and answers must be tailored to the following marks value: ${marks} mark${marks > 1 ? 's' : ''}.
4. If marks is 1 or 2: ALL questions must be short, direct, and simple, and ALL answers must be concise (1 mark: about 15 words, 2 marks: about 30 words). Do NOT generate any descriptive or analytical questions for marks 1 or 2.
5. If marks is 3, 4, or 5: ALL questions must be long, descriptive, and analytical, and ALL answers must be detailed and explanatory (3 marks: about 45 words, 4 marks: about 60 words, 5 marks: at least 75 words). Do NOT generate any short or direct questions for marks 3, 4, or 5.
6. Each question must relate to potential facts, concepts, or information in this specific content.
7. Avoid overly generic questions; focus on the likely subject matter.

IMPORTANT: Do NOT mix question types. For marks 1 or 2, only short/direct questions. For marks 3, 4, or 5, only descriptive/analytical questions. Answers must always match the required word count for the marks value.

Format your response as a JSON array with objects containing "question" and "answer" properties. Example:
[
  {
    "question": "What is the main concept discussed in the document?",
    "answer": "The document likely discusses photosynthesis as the process by which plants convert light energy into chemical energy."
  }
]

Base your questions and answers on the inferred content of this document based on its metadata. Strictly follow the answer word count and question descriptiveness based on the marks value.`;

      // Send request to Groq API
      const response = await axios.post(
        GROQ_API_URL,
        {
          model: "llama3-70b-8192",
          messages: [
            {
              role: "user",
              content: prompt,
            },
          ],
          temperature: 0.2,
          max_tokens: 2048,
        },
        {
          headers: {
            Authorization: `Bearer ${GROQ_API_KEY}`,
            "Content-Type": "application/json",
          },
        }
      );

      const text = response.data.choices[0].message.content;
      console.log("Received response from Groq API:", text.substring(0, 200) + "...");

      // Try to parse the response as JSON by cleaning markdown formatting
      let questions = [];
      let answers = [];
      let jsonError = null;
      try {
        // Clean the response text by removing markdown code block indicators
        let cleanedText = text
          .replace(/```json/g, '')
          .replace(/```/g, '')
          .replace(/`/g, '')
          .trim();

        // Extract the first JSON array using regex (robust to extra text)
        const arrayMatch = cleanedText.match(/\[\s*{[\s\S]*?}\s*\]/);
        if (arrayMatch) {
          cleanedText = arrayMatch[0];
        }

        // Fix common JSON issues
        cleanedText = cleanedText
          .replace(/,\s*}/g, '}')
          .replace(/,\s*]/g, ']')
          .replace(/\r?\n/g, '')
          .replace(/\s+/g, ' ')
          .replace(/\'([^']*)\'/g, '"$1"')
          .replace(/([\{,])\s*([a-zA-Z0-9_]+)\s*:/g, '$1 "$2":')
          .replace(/([:,])\s*"\s*([^\"]*?)\s*"\s*([,}\]])/g, '$1 "$2"$3')
          .replace(/\"\s*\"/g, '""')
          .replace(/\},\s*\}/g, '}}')
          .replace(/\},\s*\]/g, '}]');

        // Try to parse the cleaned text as JSON
        let jsonData;
        try {
          jsonData = JSON.parse(cleanedText);
        } catch (parseErr) {
          // Try to repair: remove trailing characters after last closing bracket
          const lastBracket = cleanedText.lastIndexOf(']');
          if (lastBracket !== -1) {
            const repaired = cleanedText.slice(0, lastBracket + 1);
            try {
              jsonData = JSON.parse(repaired);
            } catch (repairErr) {
              // As a last resort, try to remove any trailing commas before closing brackets
              const moreRepaired = repaired.replace(/,\s*([}\]])/g, '$1');
              try {
                jsonData = JSON.parse(moreRepaired);
              } catch (finalErr) {
                console.error("Final JSON parse failed. cleanedText:", cleanedText);
                jsonData = null;
              }
            }
          }
        }
        if (Array.isArray(jsonData)) {
          for (const item of jsonData) {
            if (item && item.question && item.answer) {
              questions.push(item.question);
              answers.push(item.answer);
            }
          }
        }
      } catch (err) {
        jsonError = err;
        console.error("Failed to parse JSON response (array extraction):", err);
      }

      // Fallback: extract all {question, answer} objects from anywhere in the text (tolerant to missing commas)
      if (questions.length === 0) {
        try {
          const objRegex = /\{[^}]*?"question"\s*:\s*"([^"]+)"[^}]*?"answer"\s*:\s*"([^"]+)"[^}]*?\}/g;
          let match;
          while ((match = objRegex.exec(text)) !== null) {
            questions.push(match[1]);
            answers.push(match[2]);
          }
        } catch (fallbackErr) {
          console.error("Fallback object extraction failed:", fallbackErr);
        }
      }

      // Fallback: use line-based extraction if still nothing
      if (questions.length === 0) {
        const extractedData = extractQuestionsAndAnswers(text);
        questions = extractedData.questions;
        answers = extractedData.answers;
      }

      // Fallback: generate from file name if still nothing
      if (questions.length === 0) {
        const fileName = file.name.replace(/\.[^/.]+$/, "").replace(/[_-]/g, " ");
        questions = generateFallbackQuestions(fileName);
        answers = questions.map((q) => generateDefaultAnswer(q));
      }

      return NextResponse.json({
        success: true,
        questions,
        answers,
      });
    } catch (error: unknown) { // Use unknown to comply with TypeScript
      if (error instanceof AxiosError) {
        console.error("Error generating content with Groq API:", {
          message: error.message,
          status: error.response?.status,
          data: error.response?.data,
        });
      } else {
        console.error("Unexpected error generating content with Groq API:", error);
      }

      // Fallback questions based on file name
      const fileName = file.name.replace(/\.[^/.]+$/, "").replace(/[_-]/g, " ");
      const fallbackQuestions = generateFallbackQuestions(fileName);
      const fallbackAnswers = fallbackQuestions.map((q) => generateDefaultAnswer(q));

      return NextResponse.json({
        success: true,
        questions: fallbackQuestions,
        answers: fallbackAnswers,
      });
    }
  } catch (error: unknown) {
    console.error("Error processing request:", error instanceof Error ? error.message : String(error));
    return NextResponse.json(
      {
        success: false,
        error: "Server error. Please try again.",
      },
      { status: 500 }
    );
  }
}

// Helper function to extract questions and answers from text
function extractQuestionsAndAnswers(text: string): { questions: string[]; answers: string[] } {
  const questions: string[] = [];
  const answers: string[] = [];

  // Try to extract numbered questions and their answers
  const lines = text.split(/\r?\n/);
  let currentQuestion = "";
  let currentAnswer = "";
  let isCollectingAnswer = false;

  for (const line of lines) {
    const trimmedLine = line.trim();

    // Check if this line starts a new question (e.g., "1. What is...")
    const questionMatch = trimmedLine.match(/^\d+[.)]\s+(.+)/);

    if (questionMatch) {
      // If we were collecting an answer, save it
      if (currentQuestion && isCollectingAnswer) {
        answers.push(currentAnswer.trim());
        currentAnswer = "";
      }

      // If we have a question from before, save it
      if (currentQuestion) {
        questions.push(currentQuestion);
      }

      // Start new question
      currentQuestion = questionMatch[1];
      isCollectingAnswer = false;
    }
    // Check if this line starts an answer (after a question)
    else if (
      currentQuestion &&
      !isCollectingAnswer &&
      (trimmedLine.startsWith("Answer:") ||
        trimmedLine.startsWith("A:") ||
        trimmedLine === "" ||
        trimmedLine.startsWith("-"))
    ) {
      isCollectingAnswer = true;
      currentAnswer = trimmedLine.replace(/^(Answer:|A:)\s*/, "");
    }
    // Continue collecting the answer
    else if (isCollectingAnswer) {
      currentAnswer += " " + trimmedLine;
    }
    // If not a question start or answer, it might be part of the current question
    else if (currentQuestion && !isCollectingAnswer) {
      currentQuestion += " " + trimmedLine;
    }
  }

  // Add the last question and answer if they exist
  if (currentQuestion) {
    questions.push(currentQuestion);
    if (isCollectingAnswer) {
      answers.push(currentAnswer.trim());
    } else {
      answers.push(generateDefaultAnswer(currentQuestion));
    }
  }

  // If we couldn't extract paired questions and answers, try just extracting questions
  if (questions.length === 0) {
    const questionRegex = /(?:^|\n)(?:\d+[.)]\s+)([^\n]+)/g;
    let match;

    while ((match = questionRegex.exec(text)) !== null) {
      questions.push(match[1].trim());
    }

    // Generate default answers for these questions
    for (const question of questions) {
      answers.push(generateDefaultAnswer(question));
    }
  }

  return { questions, answers };
}

// Helper function to generate default answers
function generateDefaultAnswer(question: string): string {
  // Remove question marks and convert to statement
  const baseAnswer = question.replace(/\?/g, "").trim();

  // Create a simple answer based on the question
  if (question.toLowerCase().startsWith("what is") || question.toLowerCase().startsWith("what are")) {
    return `${baseAnswer} is an important concept in this material. The document provides details about this topic that you should review carefully.`;
  } else if (question.toLowerCase().startsWith("how")) {
    return `The process or method for ${baseAnswer} is outlined in the material. Review the specific steps or methodology described.`;
  } else if (question.toLowerCase().startsWith("why")) {
    return `The reason for ${baseAnswer} is explained in the content. Understanding this rationale is key to mastering the subject.`;
  } else if (question.toLowerCase().includes("example")) {
    return `The material provides examples of ${baseAnswer}. Study these examples to better understand the practical applications.`;
  } else if (question.toLowerCase().includes("difference") || question.toLowerCase().includes("compare")) {
    return `The distinction between these concepts is highlighted in the material. Pay attention to the key differences and similarities.`;
  } else {
    return `This is an important question based on the material. Review the content carefully to find the detailed answer.`;
  }
}

// Helper function to generate fallback questions based on file name
function generateFallbackQuestions(fileName: string): string[] {
  const topics = fileName.split(/\s+/).filter((word) => word.length > 3);

  // If we can't extract meaningful topics, use generic educational topics
  const subjectTopics = topics.length > 1 ? topics : ["science", "math", "history", "literature", "geography"];

  const questions = [
    `What are the key concepts of ${subjectTopics[0] || "this topic"}?`,
    `How does ${subjectTopics[0] || "this subject"} relate to ${subjectTopics[1] || "other fields"}?`,
    `Why is ${subjectTopics[0] || "this topic"} important in modern education?`,
    `What are the practical applications of ${subjectTopics[0] || "these concepts"}?`,
    `How has our understanding of ${subjectTopics[0] || "this subject"} evolved over time?`,
    `What are the main challenges in learning ${subjectTopics[0] || "this material"}?`,
    `Can you explain the difference between ${subjectTopics[0] || "concept A"} and ${subjectTopics[1] || "concept B"}?`,
    `What examples illustrate the principles of ${subjectTopics[0] || "this topic"}?`,
    `How would you summarize the core ideas presented in this material?`,
    `What further research questions emerge from studying ${subjectTopics[0] || "this topic"}?`,
  ];

  return questions;
}