#!/usr/bin/env bash
set -euo pipefail

# ── 顏色 ────────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; BOLD='\033[1m'; RESET='\033[0m'

info()    { echo -e "${BLUE}[•]${RESET} $*"; }
success() { echo -e "${GREEN}[✓]${RESET} $*"; }
warn()    { echo -e "${YELLOW}[!]${RESET} $*"; }
error()   { echo -e "${RED}[✗]${RESET} $*"; exit 1; }
step()    { echo -e "\n${BOLD}── $* ──${RESET}"; }

# ── Banner ───────────────────────────────────────────────────────────────────
echo -e "${BOLD}"
echo "  ██████╗ ██████╗ ██████╗  ██████╗     ███████╗██████╗ ██╗███████╗███╗   ██╗██████╗ "
echo "  ╚════██╗╚════██╗╚════██╗██╔═████╗    ██╔════╝██╔══██╗██║██╔════╝████╗  ██║██╔══██╗"
echo "   █████╔╝ █████╔╝ █████╔╝██║██╔██║    █████╗  ██████╔╝██║█████╗  ██╔██╗ ██║██║  ██║"
echo "  ██╔═══╝  ╚═══██╗██╔═══╝ ████╔╝██║    ██╔══╝  ██╔══██╗██║██╔══╝  ██║╚██╗██║██║  ██║"
echo "  ███████╗██████╔╝███████╗╚██████╔╝    ██║     ██║  ██║██║███████╗██║ ╚████║██████╔╝"
echo "  ╚══════╝╚═════╝ ╚══════╝ ╚═════╝     ╚═╝     ╚═╝  ╚═╝╚═╝╚══════╝╚═╝  ╚═══╝╚═════╝ "
echo -e "${RESET}  台積電 TSMC 輿情追蹤 — Akamai Wasm Functions\n"

# ── 讀取選項 ─────────────────────────────────────────────────────────────────
LOCAL=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --local|-l) LOCAL=true; shift ;;
    --help|-h)
      echo "用法："
      echo "  ./deploy.sh            # 部署到 Akamai"
      echo "  ./deploy.sh --local    # 只在本地執行 (spin up)"
      exit 0 ;;
    *) error "未知參數：$1。使用 --help 查看說明" ;;
  esac
done

# ── 1. 檢查必要工具 ───────────────────────────────────────────────────────────
step "檢查環境"

check_cmd() {
  if ! command -v "$1" &>/dev/null; then
    error "$1 未安裝。$2"
  fi
  success "$1 $(\"$1\" --version 2>&1 | head -1)"
}

check_cmd node  "請至 https://nodejs.org 安裝 Node.js 20+"
check_cmd npm   "隨 Node.js 一起安裝"
check_cmd spin  "請執行：curl -fsSL https://developer.fermyon.com/downloads/install.sh | bash"

if ! $LOCAL; then
  if ! spin aka --help &>/dev/null 2>&1; then
    warn "spin-aka 外掛未安裝，正在安裝..."
    spin plugins install aka --yes || error "無法安裝 spin-aka 外掛"
  fi
  success "spin-aka 已就緒"
fi

# ── 2. 讀取 Fugle API Key ─────────────────────────────────────────────────────
step "Fugle API Key"

FUGLE_API_KEY="${FUGLE_API_KEY:-}"

# 先嘗試從 .env 讀取
if [[ -z "$FUGLE_API_KEY" && -f .env ]]; then
  FUGLE_API_KEY=$(grep -E '^FUGLE_API_KEY=' .env | cut -d'=' -f2- | tr -d '"' | tr -d "'")
fi

if [[ -z "$FUGLE_API_KEY" ]]; then
  warn "未設定 FUGLE_API_KEY，股價將 fallback 使用 TWSE API"
  warn "若需使用富果，請："
  echo "  1. 申請 Key：https://developer.fugle.tw/"
  echo "  2. 建立 .env 檔案：echo 'FUGLE_API_KEY=你的key' > .env"
  echo "     或設定環境變數：export FUGLE_API_KEY=你的key"
  FUGLE_VAR_ARG=""
else
  success "Fugle API Key 已設定（${FUGLE_API_KEY:0:4}****）"
  FUGLE_VAR_ARG="--variable fugle_api_key=${FUGLE_API_KEY}"
fi

# ── 3. 安裝 npm 套件 ──────────────────────────────────────────────────────────
step "安裝依賴"

if [[ ! -d node_modules ]]; then
  info "執行 npm install..."
  npm install
else
  info "node_modules 已存在，略過（如需更新請手動執行 npm install）"
fi
success "依賴就緒"

# ── 4. 建置 Wasm component ────────────────────────────────────────────────────
step "建置 Wasm component"

info "執行 spin build..."
spin build || error "建置失敗，請檢查上方錯誤訊息"
success "建置完成 → dist/main.wasm"

# ── 5a. 本地模式 ──────────────────────────────────────────────────────────────
if $LOCAL; then
  step "本地啟動"
  info "執行 spin up..."
  echo ""

  if [[ -n "$FUGLE_VAR_ARG" ]]; then
    exec spin up $FUGLE_VAR_ARG
  else
    exec spin up
  fi
fi

# ── 5b. 部署到 Akamai ─────────────────────────────────────────────────────────
step "部署到 Akamai"

# 確認已登入
if ! spin aka whoami &>/dev/null 2>&1; then
  warn "尚未登入 Akamai，開始登入流程..."
  spin aka login || error "登入失敗"
fi

CURRENT_USER=$(spin aka whoami 2>/dev/null || echo "未知")
info "登入身份：${CURRENT_USER}"

info "部署中，請稍候..."
if [[ -n "$FUGLE_VAR_ARG" ]]; then
  spin aka deploy $FUGLE_VAR_ARG
else
  spin aka deploy
fi

# ── 完成 ──────────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}${BOLD}🚀 部署成功！${RESET}"
echo ""
echo -e "  ${BOLD}更新 Fugle Key：${RESET}"
echo "  spin aka deploy --variable fugle_api_key=新的KEY"
echo ""
echo -e "  ${BOLD}查看 API：${RESET}"
echo "  /api/stock    股價（60s 快取）"
echo "  /api/ptt      PTT 貼文（5min 快取）"
echo "  /api/dcard    Dcard 貼文（5min 快取）"
echo "  /api/sentiment 輿情分析"
