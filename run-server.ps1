# ==========================================================================
# VANISHCHAT LOCAL LAUNCHER FOR NODE.JS SERVER
# ==========================================================================

$port = 8088

# Check if Node.js is installed
$nodeInstalled = Get-Command node -ErrorAction SilentlyContinue

Clear-Host
Write-Host "==========================================================" -ForegroundColor Magenta
Write-Host "                VANISHCHAT LOCAL LAUNCHER                 " -ForegroundColor DarkMagenta
Write-Host "==========================================================" -ForegroundColor Magenta
Write-Host ""

if ($nodeInstalled) {
    Write-Host "Node.js detected. Installing dependencies..." -ForegroundColor Yellow
    npm install
    
    Write-Host ""
    Write-Host "Starting VanishChat Server..." -ForegroundColor Green
    Write-Host "-> PC URL:      http://localhost:$port/" -ForegroundColor Cyan
    Write-Host "Press [Ctrl + C] to stop the server at any time." -ForegroundColor DarkRed
    Write-Host "==========================================================" -ForegroundColor Magenta
    Write-Host ""
    
    node server.js
} else {
    Write-Host "Node.js was not found on your system." -ForegroundColor Red
    Write-Host ""
    Write-Host "To run this chat server locally on your PC, you need to install Node.js:" -ForegroundColor Yellow
    Write-Host "1. Download and install Node.js from: https://nodejs.org/" -ForegroundColor Cyan
    Write-Host "2. Once installed, re-run this script to launch the chat room." -ForegroundColor Cyan
    Write-Host ""
    Write-Host "To host it online for FREE (so you can use it on mobile without PC):" -ForegroundColor Green
    Write-Host "Please check the walkthrough.md file in your browser or chat!" -ForegroundColor Cyan
    Write-Host "==========================================================" -ForegroundColor Magenta
    Write-Host ""
    
    Read-Host "Press Enter to exit..."
}
