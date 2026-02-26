"""
AI Router — Powers all 6 Testing Page AI features via Google Gemini.
Uses the GEMINI_API_KEY from the project .env file.
"""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional, List, Dict, Any
import os, sys, json
from pathlib import Path
from dotenv import load_dotenv
import google.generativeai as genai

# Load .env from project root
_project_root = Path(__file__).resolve().parents[2]  # SynnccIT/
load_dotenv(_project_root / ".env", override=True)

# Add backend dir to path
_backend_dir = Path(__file__).parent.parent
if str(_backend_dir) not in sys.path:
    sys.path.insert(0, str(_backend_dir))

from services.code_executor import CodeExecutor
from services.test_generator import TestCaseGenerator

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
if not GEMINI_API_KEY:
    print("⚠️  GEMINI_API_KEY not found in .env — AI features will fail.")
else:
    print(f"✅ Loaded Gemini API Key: {GEMINI_API_KEY[:10]}...{GEMINI_API_KEY[-10:]}")

# Configure Gemini
genai.configure(api_key=GEMINI_API_KEY)
# Initialize the model
MODEL_NAME = os.getenv("GEMINI_MODEL", "gemini-flash-latest")
model = genai.GenerativeModel(MODEL_NAME)

ai_router = APIRouter()
executor = CodeExecutor()
test_gen = TestCaseGenerator()


# ─── Request / Response Models ───────────────────────────────────────────────

class CodeInput(BaseModel):
    code: str
    selected_text: Optional[str] = None  # For Code Explanation
    user_input: Optional[str] = None     # For Simulate Runs / Re-Design
    language: str = "python"


class AIResponse(BaseModel):
    result: str
    metrics: Optional[Dict[str, Any]] = None
    test_results: Optional[List[Dict[str, Any]]] = None


# ─── Helper: Call Gemini ─────────────────────────────────────────────────────

def ask_ai(system_prompt: str, user_prompt: str) -> str:
    """Call Google Gemini and return the response text."""
    try:
        # Combine system and user prompt for Gemini
        combined_prompt = f"{system_prompt}\n\nUser Request: {user_prompt}"
        response = model.generate_content(combined_prompt)
        return response.text.strip()
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Gemini error: {str(e)}")


# ─── 1. Run Quick Tests ──────────────────────────────────────────────────────

@ai_router.post("/quick-test")
async def quick_test(input: CodeInput):
    """
    AI reviews the code and gives crisp, highlights-style feedback.
    Also runs auto-generated test cases for concrete results.
    """
    # Step 1: Run actual test cases
    testcases = test_gen.generate_testcases(input.code)
    test_results = []
    for tc in testcases:
        result = executor.execute_python(input.code, input_data=tc.get("input", ""))
        test_results.append({
            "input": tc.get("input", ""),
            "expected": tc.get("expected", ""),
            "actual": result["output"].strip(),
            "error": result.get("error", ""),
            "runtime": f"{result.get('runtime', 0)}s",
            "passed": result["output"].strip() == tc.get("expected", "").strip()
        })

    passed = sum(1 for r in test_results if r["passed"])
    total = len(test_results)

    # Step 2: AI review
    ai_review = ask_ai(
        system_prompt="You are a senior code reviewer. Give a crisp, highlights-style review of the code. Use bullet points. Keep it concise (max 10 bullet points). Cover: correctness, edge cases, style, potential bugs, and performance. End with an overall verdict.",
        user_prompt=f"Review this {input.language} code:\n\n```\n{input.code}\n```\n\nTest execution results: {passed}/{total} tests passed."
    )

    # Step 3: AI-evaluated metrics
    efficiency = min(100, max(0, int((passed / max(total, 1)) * 70) + 15))
    scalability = min(100, max(0, 65 - (input.code.count("for ") + input.code.count("while ")) * 8 + 10))

    return {
        "result": ai_review,
        "test_results": test_results,
        "metrics": {"efficiency": efficiency, "scalability": scalability}
    }


# ─── 2. Generate Test Cases ──────────────────────────────────────────────────

@ai_router.post("/generate-tests")
async def generate_tests(input: CodeInput):
    """
    AI generates artificial test data and suggests print-statement debugging.
    """
    ai_response = ask_ai(
        system_prompt="""You are a test engineer. Given the code:
1. Generate 5 meaningful test cases with input values and expected outputs. Format each as:
   Test Case N:
   Input: <value>
   Expected Output: <value>
   
2. After the test cases, suggest where to place temporary print statements at the end of each step/process to debug how the code runs. Format as:
   Debug Suggestions:
   - After line N: print(f"variable_name = {variable_name}")
   
Keep it practical and useful.""",
        user_prompt=f"Code:\n```{input.language}\n{input.code}\n```"
    )

    # Also run the backend test generator for actual execution
    testcases = test_gen.generate_testcases(input.code)
    executed_results = []
    for tc in testcases:
        result = executor.execute_python(input.code, input_data=tc.get("input", ""))
        executed_results.append({
            "input": tc.get("input", ""),
            "expected": tc.get("expected", ""),
            "actual": result["output"].strip(),
            "passed": result["output"].strip() == tc.get("expected", "").strip()
        })

    return {
        "result": ai_response,
        "test_results": executed_results,
        "metrics": None
    }


# ─── 3. Code Explanation ─────────────────────────────────────────────────────

@ai_router.post("/code-explain")
async def code_explain(input: CodeInput):
    """
    Deciphers highlighted code or the full file if nothing is selected.
    """
    code_to_explain = input.selected_text or input.code
    context = "This is a highlighted portion of a larger file." if input.selected_text else "This is the complete file."

    ai_response = ask_ai(
        system_prompt=f"""You are an expert code explainer. {context}
Explain the code in a clear, line-by-line manner. For each logical block:
- State what it does in plain English
- Explain WHY it does it (the purpose)
- Note any patterns, algorithms, or data structures used
- Flag any potential issues

Use clear formatting with headers and bullet points. Be concise but thorough.""",
        user_prompt=f"Explain this {input.language} code:\n\n```\n{code_to_explain}\n```"
    )

    return {"result": ai_response, "metrics": None, "test_results": None}


# ─── 4. Simulate Runs ────────────────────────────────────────────────────────

@ai_router.post("/simulate")
async def simulate_runs(input: CodeInput):
    """
    Execute code with user-provided input values in a sandboxed environment.
    """
    if not input.user_input or not input.user_input.strip():
        # If no input provided, ask AI what inputs the code needs
        ai_response = ask_ai(
            system_prompt="You are a code analyst. Analyze the code and tell the user exactly what inputs it expects. Be very specific about format, types, and number of inputs needed. Give 2-3 example input sets they can try.",
            user_prompt=f"What inputs does this code need?\n\n```{input.language}\n{input.code}\n```"
        )
        return {"result": ai_response, "metrics": None, "test_results": None}

    # Execute with user input
    result = executor.execute_python(input.code, input_data=input.user_input)

    output_text = f"🚀 Simulation Result\n\n"
    output_text += f"📥 Input:\n{input.user_input}\n\n"
    output_text += f"📤 Output:\n{result['output'].strip() or '(no output)'}\n\n"

    if result.get("error"):
        output_text += f"⚠️ Errors:\n{result['error']}\n\n"

    output_text += f"⏱️ Runtime: {result.get('runtime', 0)}s\n"
    output_text += f"Status: {'✅ Success' if result.get('success') else '❌ Failed'}"

    # AI analysis of the result
    ai_analysis = ask_ai(
        system_prompt="You are a runtime analyst. Given the code, input, and output, provide a brief analysis (3-5 bullet points) of what just happened. Note any issues, edge cases, or unexpected behavior.",
        user_prompt=f"Code:\n```\n{input.code}\n```\n\nInput: {input.user_input}\nOutput: {result['output'].strip()}\nErrors: {result.get('error', 'none')}"
    )

    output_text += f"\n\n📊 AI Analysis:\n{ai_analysis}"

    return {"result": output_text, "metrics": None, "test_results": None}


# ─── 5. Reduce Complexity ────────────────────────────────────────────────────

@ai_router.post("/reduce-complexity")
async def reduce_complexity(input: CodeInput):
    """
    AI provides methods/suggestions to reduce space and time complexity.
    """
    ai_response = ask_ai(
        system_prompt="""You are an algorithm optimization expert. Analyze the code and provide:

1. **Current Complexity Analysis**:
   - Time complexity (Big-O) with explanation
   - Space complexity (Big-O) with explanation

2. **Optimization Suggestions** (ranked by impact):
   - Each suggestion should include WHAT to change, WHY it helps, and the new complexity
   - Include code snippets showing the optimized version where possible

3. **Data Structure Recommendations**:
   - Suggest better data structures if applicable

4. **Scores** (at the very end, on separate lines, ONLY DO THIS AT THE END):
   EFFICIENCY_SCORE: <number 0-100>
   SCALABILITY_SCORE: <number 0-100>

Be specific and actionable. Don't be generic.""",
        user_prompt=f"Analyze and optimize this {input.language} code:\n\n```\n{input.code}\n```"
    )

    # Parse scores from AI response
    efficiency = 50
    scalability = 50
    for line in ai_response.split("\n"):
        if "EFFICIENCY_SCORE:" in line:
            try:
                efficiency = int(line.split(":")[1].strip())
            except:
                pass
        if "SCALABILITY_SCORE:" in line:
            try:
                scalability = int(line.split(":")[1].strip())
            except:
                pass

    return {
        "result": ai_response,
        "metrics": {"efficiency": efficiency, "scalability": scalability},
        "test_results": None
    }


# ─── 6. Re-Design ────────────────────────────────────────────────────────────

@ai_router.post("/redesign")
async def redesign(input: CodeInput):
    """
    AI implements the user's thoughts into code redesign.
    """
    code_to_redesign = input.selected_text or input.code
    user_requirements = input.user_input or "Improve the overall design and structure"

    ai_response = ask_ai(
        system_prompt="""You are a senior software architect. The user wants to redesign their code. 
Provide:
1. **Analysis** of the current design (brief)
2. **Redesigned Code** — the full rewritten version implementing the user's requirements
3. **Changes Summary** — bullet points of what changed and why

Make the redesigned code complete, runnable, and well-documented with comments.""",
        user_prompt=f"User's requirements: {user_requirements}\n\nCode to redesign:\n```{input.language}\n{code_to_redesign}\n```"
    )

    return {"result": ai_response, "metrics": None, "test_results": None}
