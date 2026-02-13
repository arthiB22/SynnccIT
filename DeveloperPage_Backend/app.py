from fastapi import FastAPI, Request, UploadFile, File, Form
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
import os
import subprocess
from typing import List, Optional, Dict

# Try to import google.generativeai, handle if missing
try:
    import google.generativeai as genai
    HAS_GENAI = True
except ImportError:
    HAS_GENAI = False

app = FastAPI()

# Allow CORS for frontend dev
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

from dotenv import load_dotenv
load_dotenv()

# Global state for terminal current working directory
CURRENT_DIR = os.getcwd()

# Configure GenAI if available
if HAS_GENAI:
    api_key = os.getenv("GEMINI_API_KEY")
    if api_key and api_key != "YOUR_GEMINI_API_KEY":
        genai.configure(api_key=api_key)
        try:
            model_name = os.getenv("GEMINI_MODEL", "gemini-1.5-flash")
            model = genai.GenerativeModel(model_name)
        except:
            model = None
    else:
        model = None
else:
    model = None

class FileSaveRequest(BaseModel):
    path: str
    content: str

class TerminalRequest(BaseModel):
    command: str

class AgentRequest(BaseModel):
    prompt: str

@app.get("/api/files")
def list_files(path: Optional[str] = None):
    global CURRENT_DIR
    
    # If a new path is provided, update the global CURRENT_DIR
    if path and path != ".":
        target = os.path.abspath(path)
        if os.path.exists(target) and os.path.isdir(target):
            CURRENT_DIR = target
    
    base = CURRENT_DIR
    if not os.path.exists(base):
        return JSONResponse(status_code=404, content={"error": "Path not found"})
    
    def build_tree(p):
        try:
            entries = os.listdir(p)
        except PermissionError:
            return None
            
        children = []
        for f in entries:
            full_path = os.path.join(p, f)
            if os.path.isdir(full_path):
                child_data = build_tree(full_path)
                if child_data:
                    children.append(child_data)
                else:
                    children.append({
                        "id": full_path,
                        "name": f,
                        "type": "folder",
                        "path": full_path,
                        "children": []
                    })
            else:
                children.append({
                    "id": full_path,
                    "name": f,
                    "type": "file",
                    "path": full_path
                })
        
        return {
            "id": p,
            "name": os.path.basename(p) if os.path.basename(p) else p,
            "type": "folder",
            "path": p,
            "children": sorted(children, key=lambda x: (x['type'] != 'folder', x['name'].lower()))
        }

    if os.path.isdir(base):
        result = build_tree(base)
        return result if result else JSONResponse(status_code=400, content={"error": "Cannot read directory"})
    else:
        return JSONResponse(status_code=400, content={"error": "Not a directory"})

@app.get("/api/file")
def read_file(path: str):
    if not os.path.exists(path):
        return JSONResponse(status_code=404, content={"error": "File not found"})
    try:
        with open(path, "r", encoding="utf-8") as f:
            content = f.read()
        return {"path": path, "content": content}
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})

@app.post("/api/file")
def save_file(req: FileSaveRequest):
    try:
        with open(req.path, "w", encoding="utf-8") as f:
            f.write(req.content)
        return {"success": True}
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})

@app.post("/api/terminal")
def run_terminal(req: TerminalRequest):
    global CURRENT_DIR
    command = req.command.strip()
    
    # Handle cd command specifically
    if command.startswith("cd "):
        target_dir = command[3:].strip()
        new_dir = os.path.abspath(os.path.join(CURRENT_DIR, target_dir))
        if os.path.exists(new_dir) and os.path.isdir(new_dir):
            CURRENT_DIR = new_dir
            return {
                "stdout": "",
                "stderr": "",
                "returncode": 0,
                "cwd": CURRENT_DIR
            }
        else:
            return {
                "stdout": "",
                "stderr": f"cd: no such file or directory: {target_dir}\n",
                "returncode": 1,
                "cwd": CURRENT_DIR
            }

    try:
        # Run command in the tracked, persistent CURRENT_DIR
        result = subprocess.run(
            req.command, 
            shell=True, 
            capture_output=True, 
            text=True,
            cwd=CURRENT_DIR
        )
        return {
            "stdout": result.stdout,
            "stderr": result.stderr,
            "returncode": result.returncode,
            "cwd": CURRENT_DIR
        }
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})

@app.post("/api/open-folder")
def open_folder(req: Dict[str, str]):
    path = req.get("path")
    if not path or not os.path.exists(path):
        return JSONResponse(status_code=404, content={"error": "Path not found"})
    
    try:
        import platform
        system = platform.system()
        if system == "Darwin":  # macOS
            subprocess.run(["open", path])
        elif system == "Windows":
            os.startfile(path)
        else:  # Linux
            subprocess.run(["xdg-open", path])
        return {"success": True}
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})

@app.post("/api/upload")
async def upload_file(file: UploadFile = File(...), path: Optional[str] = Form(None)):
    global CURRENT_DIR
    # Use provided path (folder) or default to CURRENT_DIR
    target_dir = path if path else CURRENT_DIR
    if not os.path.isabs(target_dir):
        target_dir = os.path.join(CURRENT_DIR, target_dir)
    
    if not os.path.exists(target_dir):
        os.makedirs(target_dir, exist_ok=True)
        
    file_path = os.path.join(target_dir, file.filename)
    try:
        with open(file_path, "wb") as buffer:
            content = await file.read()
            buffer.write(content)
        return {"success": True, "path": file_path}
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})

@app.post("/api/select-workspace-folder")
def select_workspace_folder():
    try:
        import platform
        if platform.system() == "Darwin":  # macOS
            cmd = 'osascript -e "POSIX path of (choose folder with prompt \\"Select Workspace Folder\\")"'
            result = subprocess.check_output(cmd, shell=True, text=True).strip()
            if result:
                return {"path": result}
        return {"error": "Native selector only available on macOS"}
    except Exception as e:
        return {"error": str(e)}

@app.post("/api/open-terminal")
def open_terminal():
    global CURRENT_DIR
    try:
        import platform
        system = platform.system()
        if system == "Darwin":  # macOS
            subprocess.run(["open", "-a", "Terminal", CURRENT_DIR])
        elif system == "Windows":
            subprocess.run(["start", "cmd"], shell=True, cwd=CURRENT_DIR)
        else:  # Linux
            subprocess.run(["x-terminal-emulator"], cwd=CURRENT_DIR)
        return {"success": True}
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})

@app.post("/api/agent")
def run_agent(req: AgentRequest):
    if not HAS_GENAI:
        return JSONResponse(status_code=503, content={"error": "Google Generative AI library not installed"})
    if not model:
        return JSONResponse(status_code=503, content={"error": "Gemini API Key not configured"})

    try:
        context = "You are a terminal expert. Translate natural language to shell commands."
        prompt = f"""
        {context}
        User Intent: {req.prompt}
        OS: {os.name}
        
        Return the result in this exact format:
        COMMAND: [single line command]
        EXPLANATION: [briefly explain what it does]
        SAFE: [YES/NO] (NO if it deletes files or changes system settings)
        """
        
        response = model.generate_content(prompt)
        lines = response.text.strip().split('\n')
        
        result = {}
        for line in lines:
            if line.startswith("COMMAND:"): result['cmd'] = line.replace("COMMAND:", "").strip()
            if line.startswith("EXPLANATION:"): result['desc'] = line.replace("EXPLANATION:", "").strip()
            if line.startswith("SAFE:"): result['safe'] = line.replace("SAFE:", "").strip()
            
        return result
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})
