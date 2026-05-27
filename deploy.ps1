# AWS Deployment Script for ProjectManager AI
# This script zips the backend for Lambda and syncs the frontend to S3.

# ==============================================================================
# CONFIGURATION
# ==============================================================================
$LAMBDA_FUNCTION_NAME = "ProjectManagerBackend"
$S3_BUCKET_NAME = "s3://project-manager-web-898934810428"
# ==============================================================================

Write-Host "------------------------------------------------------------"
Write-Host " Starting ProjectManager AI Deployment"
Write-Host "------------------------------------------------------------"

try {
    # --- 1. Backend Deployment (Lambda) ---
    Write-Host " Preparing Backend..."
    $zipFile = "lambda_deploy.zip"
    if (Test-Path $zipFile) { Remove-Item $zipFile }

    Write-Host "Zipping backend contents..."
    Push-Location backend
    Compress-Archive -Path * -DestinationPath ..\$zipFile
    Pop-Location

    Write-Host "Uploading to AWS Lambda: $LAMBDA_FUNCTION_NAME..."
    $out = aws lambda update-function-code --function-name $LAMBDA_FUNCTION_NAME --zip-file "fileb://$zipFile"
    
    if ($LASTEXITCODE -eq 0) {
        Write-Host " Backend deployed successfully!"
    } else {
        throw "Failed to update Lambda function code."
    }

    # --- 2. Frontend Deployment (S3) ---
    Write-Host " Preparing Frontend..."
    Write-Host "Syncing 'frontend/' folder to $S3_BUCKET_NAME..."
    
    aws s3 sync frontend $S3_BUCKET_NAME

    if ($LASTEXITCODE -eq 0) {
        Write-Host " Frontend deployed successfully!"
    } else {
        throw "Failed to sync frontend to S3."
    }

    # Cleanup
    if (Test-Path $zipFile) { Remove-Item $zipFile }

    Write-Host "------------------------------------------------------------"
    Write-Host " DEPLOYMENT COMPLETE!"
    Write-Host "------------------------------------------------------------"

} catch {
    Write-Host " DEPLOYMENT FAILED: $($_.Exception.Message)"
    if (Test-Path $zipFile) { Remove-Item $zipFile }
    exit 1
}
