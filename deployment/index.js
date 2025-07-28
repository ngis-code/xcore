#!/usr/bin/env node

const { execSync, exec } = require('child_process');
const fs = require('fs-extra');
const path = require('path');
const inquirer = require('inquirer');
const chalk = require('chalk');
const ora = require('ora');
const cliProgress = require('cli-progress');
const { Client, Storage, ID, InputFile } = require('node-appwrite');

class DockerImageManager {
  constructor() {
    this.savedImagesDir = path.join(__dirname, 'saved-images');
    this.appwriteClient = null;
    this.storage = null;
  }

  async init() {
    console.log(chalk.blue.bold('\n🐋 Docker Image Manager'));
    console.log(chalk.gray('Manage Docker images and upload/download to/from Appwrite storage\n'));

    // Ensure saved images directory exists
    await fs.ensureDir(this.savedImagesDir);
  }

  async chooseMode() {
    const answers = await inquirer.prompt([
      {
        type: 'list',
        name: 'mode',
        message: 'What would you like to do?',
        choices: [
          {
            name: '📤 Upload Docker images to Appwrite storage',
            value: 'upload'
          },
          {
            name: '🚀 Bulk upload ALL Docker images to Appwrite storage',
            value: 'bulk-upload'
          },
          {
            name: '📥 Download and load Docker images from Appwrite storage',
            value: 'download'
          },
          {
            name: '⚡ Bulk download ALL Docker images from Appwrite storage',
            value: 'bulk-download'
          },
          {
            name: '🗑️ Remove Docker images from local system',
            value: 'remove'
          },
          {
            name: '💥 Nuclear cleanup - Remove ALL Docker containers, images, volumes, and networks',
            value: 'nuclear-cleanup'
          },
          {
            name: '🚪 Exit',
            value: 'exit'
          }
        ]
      }
    ]);

    return answers.mode;
  }

  async setupAppwrite() {
    const answers = await inquirer.prompt([
      {
        type: 'input',
        name: 'endpoint',
        message: 'Enter Appwrite endpoint:',
        default: 'http://api.ngisservices.com/v1'
      },
      {
        type: 'input',
        name: 'projectId',
        message: 'Enter Appwrite project ID:',
        default: 'xcore',
        validate: input => input.length > 0 || 'Project ID is required'
      },
      {
        type: 'input',
        name: 'apiKey',
        message: 'Enter Appwrite API key:',
        default: 'standard_3ddf66c353e67ac43337679bb79f47d5d6ab31a5b119c065034647944a33cfb1a9433004e68b7d62ade2d62dee47748de419e2d3538f7a388946cb8b5b6629aa24612374e565e1141d223de59abea04b690c98f1175eb209ee8a681569a328d4a2a5f5d5b935316556f5bdaf8d5c5b34500a963e705d43c6f0517c1a03ee6f5b',
        validate: input => input.length > 0 || 'API key is required'
      },
      {
        type: 'input',
        name: 'bucketId',
        message: 'Enter Appwrite storage bucket ID:',
        default: 'xcore',
        validate: input => input.length > 0 || 'Bucket ID is required'
      }
    ]);

    this.appwriteClient = new Client()
      .setEndpoint(answers.endpoint)
      .setProject(answers.projectId)
      .setKey(answers.apiKey);

    this.storage = new Storage(this.appwriteClient);
    this.bucketId = answers.bucketId;

    // Test connection by trying to list buckets
    try {
      console.log(chalk.blue('Testing Appwrite connection...'));
      const buckets = await this.storage.listBuckets();
      console.log(chalk.green(`✅ Connection successful! Found ${buckets.buckets.length} buckets`));
      
      // Check if our target bucket exists
      const targetBucket = buckets.buckets.find(bucket => bucket.$id === this.bucketId);
      if (targetBucket) {
        console.log(chalk.green(`✅ Target bucket '${this.bucketId}' found`));
      } else {
        console.log(chalk.yellow(`⚠️  Target bucket '${this.bucketId}' not found. Available buckets:`));
        buckets.buckets.forEach(bucket => {
          console.log(chalk.gray(`  - ${bucket.$id}: ${bucket.name}`));
        });
      }
    } catch (error) {
      console.log(chalk.red(`❌ Connection test failed: ${error.message}`));
      throw new Error('Failed to connect to Appwrite. Please check your endpoint, project ID, and API key.');
    }

    console.log(chalk.green('✅ Appwrite configured successfully\n'));
  }

  async listStorageFiles() {
    const spinner = ora('Fetching files from Appwrite storage...').start();
    
    try {
      const response = await this.storage.listFiles(this.bucketId);
      spinner.succeed(`Found ${response.files.length} files in storage`);
      
      return response.files.map(file => ({
        id: file.$id,
        name: file.name,
        size: file.sizeOriginal,
        createdAt: file.$createdAt,
        mimeType: file.mimeType,
        displaySize: this.formatFileSize(file.sizeOriginal),
        displayDate: new Date(file.$createdAt).toLocaleString()
      }));
    } catch (error) {
      spinner.fail('Failed to fetch files from storage');
      throw new Error(`Failed to list files: ${error.message}`);
    }
  }

  formatFileSize(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  async selectFilesToDownload(files) {
    if (files.length === 0) {
      console.log(chalk.yellow('No files found in storage.'));
      return [];
    }

    const choices = files.map(file => ({
      name: `${file.name} (${file.displaySize}) - ${file.displayDate}`,
      value: file,
      checked: false
    }));

    const answers = await inquirer.prompt([
      {
        type: 'checkbox',
        name: 'selectedFiles',
        message: 'Select files to download and load:',
        choices: choices,
        validate: input => input.length > 0 || 'Please select at least one file'
      }
    ]);

    return answers.selectedFiles;
  }

  async downloadFromAppwrite(file) {
    const downloadPath = path.join(this.savedImagesDir, file.name);
    const spinner = ora(`Downloading ${file.name}...`).start();
    
    try {
      // Use fetch to download file content
      const fetch = require('node-fetch');
      
      const endpoint = `${this.appwriteClient.config.endpoint}/storage/buckets/${this.bucketId}/files/${file.id}/download`;
      
      const response = await fetch(endpoint, {
        method: 'GET',
        headers: {
          'X-Appwrite-Project': this.appwriteClient.config.project,
          'X-Appwrite-Key': this.appwriteClient.config.key
        }
      });
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      
      // Get content length for progress bar
      const contentLength = response.headers.get('content-length');
      const totalSize = contentLength ? parseInt(contentLength, 10) : 0;
      
      // Create progress bar for download
      let progressBar = null;
      if (totalSize > 0) {
        progressBar = new cliProgress.SingleBar({
          format: `Downloading ${file.name} |{bar}| {percentage}% | {value}/{total} bytes | ETA: {eta}s | Speed: {speed}`,
          barCompleteChar: '\u2588',
          barIncompleteChar: '\u2591',
          hideCursor: true
        });
        progressBar.start(totalSize, 0);
      }
      
      // Write the file to local disk with progress tracking
      const fileStream = fs.createWriteStream(downloadPath);
      let downloadedBytes = 0;
      
      response.body.on('data', (chunk) => {
        downloadedBytes += chunk.length;
        if (progressBar) {
          progressBar.update(downloadedBytes);
        }
      });
      
      response.body.pipe(fileStream);
      
      return new Promise((resolve, reject) => {
        fileStream.on('finish', () => {
          if (progressBar) {
            progressBar.stop();
          }
          spinner.succeed(`Downloaded ${file.name}`);
          resolve({
            ...file,
            localPath: downloadPath
          });
        });
        
        fileStream.on('error', (error) => {
          if (progressBar) {
            progressBar.stop();
          }
          spinner.fail(`Failed to download ${file.name}`);
          reject(error);
        });
      });
      
    } catch (error) {
      spinner.fail(`Failed to download ${file.name}`);
      throw new Error(`Download failed: ${error.message}`);
    }
  }

  async loadDockerImage(downloadedFile) {
    const spinner = ora(`Loading ${downloadedFile.name} into Docker...`).start();
    
    try {
      const command = `docker load -i "${downloadedFile.localPath}"`;
      
      const output = execSync(command, { encoding: 'utf8' });
      
      // Extract loaded image name from Docker output
      const lines = output.trim().split('\n');
      const loadedLine = lines.find(line => line.includes('Loaded image:') || line.includes('Loaded image ID:'));
      
      if (loadedLine) {
        spinner.succeed(`Loaded ${downloadedFile.name} into Docker`);
        console.log(chalk.gray(`  ${loadedLine}`));
      } else {
        spinner.succeed(`Loaded ${downloadedFile.name} into Docker`);
      }
      
      return {
        ...downloadedFile,
        loaded: true,
        dockerOutput: output
      };
    } catch (error) {
      spinner.fail(`Failed to load ${downloadedFile.name} into Docker`);
      throw new Error(`Docker load failed: ${error.message}`);
    }
  }

  async getDockerImages() {
    const spinner = ora('Fetching Docker images...').start();
    
    try {
      const output = execSync('docker images --format "table {{.Repository}}\\t{{.Tag}}\\t{{.ID}}\\t{{.Size}}"', {
        encoding: 'utf8'
      });
      
      const lines = output.trim().split('\n');
      const images = [];
      
      // Skip header line
      for (let i = 1; i < lines.length; i++) {
        const parts = lines[i].split(/\s+/);
        if (parts.length >= 4) {
          images.push({
            repository: parts[0],
            tag: parts[1],
            id: parts[2],
            size: parts[3],
            fullName: `${parts[0]}:${parts[1]}`
          });
        }
      }
      
      spinner.succeed(`Found ${images.length} Docker images`);
      return images;
    } catch (error) {
      spinner.fail('Failed to fetch Docker images');
      throw new Error(`Docker command failed: ${error.message}`);
    }
  }

  async selectImages(images) {
    if (images.length === 0) {
      console.log(chalk.yellow('No Docker images found.'));
      return [];
    }

    const choices = images.map(img => ({
      name: `${img.fullName} (${img.id.substring(0, 12)}) - ${img.size}`,
      value: img,
      checked: false
    }));

    const answers = await inquirer.prompt([
      {
        type: 'checkbox',
        name: 'selectedImages',
        message: 'Select images to save and upload:',
        choices: choices,
        validate: input => input.length > 0 || 'Please select at least one image'
      }
    ]);

    return answers.selectedImages;
  }

  async selectImagesToRemove(images) {
    if (images.length === 0) {
      console.log(chalk.yellow('No Docker images found.'));
      return [];
    }

    const choices = images.map(img => ({
      name: `${img.fullName} (${img.id.substring(0, 12)}) - ${img.size}`,
      value: img,
      checked: false
    }));

    const answers = await inquirer.prompt([
      {
        type: 'checkbox',
        name: 'selectedImages',
        message: 'Select images to remove from Docker:',
        choices: choices,
        validate: input => input.length > 0 || 'Please select at least one image'
      }
    ]);

    return answers.selectedImages;
  }

  async removeDockerImage(image, force = false) {
    const spinner = ora(`Removing ${image.fullName}...`).start();
    
    try {
      const forceFlag = force ? ' -f' : '';
      const command = `docker rmi${forceFlag} ${image.fullName}`;
      
      const output = execSync(command, { encoding: 'utf8' });
      
      spinner.succeed(`Removed ${image.fullName}`);
      
      return {
        ...image,
        removed: true,
        output: output.trim()
      };
    } catch (error) {
      spinner.fail(`Failed to remove ${image.fullName}`);
      
      // Check if it's because image is being used by a container
      if (error.message.includes('image is being used by') || error.message.includes('conflict')) {
        throw new Error(`Image is being used by a container. Use force removal if needed.`);
      }
      
      throw new Error(`Docker remove failed: ${error.message}`);
    }
  }

  async saveDockerImage(image, isBulk = false) {
    let imageToSave = image;
    
    // Ask if user wants to create a new Docker tag (skip in bulk mode)
    if (!isBulk) {
      const tagAnswer = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'createTag',
          message: `Create new Docker tag for "${image.fullName}"?`,
          default: false
        }
      ]);
      
      if (tagAnswer.createTag) {
        const tagDetails = await inquirer.prompt([
          {
            type: 'input',
            name: 'repository',
            message: 'Enter new repository name:',
            default: image.repository,
            validate: input => input.trim().length > 0 || 'Repository name cannot be empty'
          },
          {
            type: 'input',
            name: 'tag',
            message: 'Enter new tag:',
            default: image.tag,
            validate: input => input.trim().length > 0 || 'Tag cannot be empty'
          }
        ]);
        
        const newFullName = `${tagDetails.repository}:${tagDetails.tag}`;
        
        // Create the new Docker tag
        const tagSpinner = ora(`Creating tag ${newFullName}...`).start();
        
        try {
          execSync(`docker tag ${image.fullName} ${newFullName}`, { stdio: 'ignore' });
          tagSpinner.succeed(`Created tag ${newFullName}`);
          
          // Update the image object to use the new tag
          imageToSave = {
            ...image,
            repository: tagDetails.repository,
            tag: tagDetails.tag,
            fullName: newFullName
          };
        } catch (error) {
          tagSpinner.fail(`Failed to create tag ${newFullName}`);
          throw new Error(`Docker tag failed: ${error.message}`);
        }
      }
    }
    
    // Generate filename based on the image we're saving (original or newly tagged)
    const sanitizedName = `${imageToSave.repository.replace(/[/\\:]/g, '_')}_${imageToSave.tag}.tar`;
    const outputPath = path.join(this.savedImagesDir, sanitizedName);
    
    const spinner = ora(`Saving ${imageToSave.fullName}...`).start();
    
    return new Promise((resolve, reject) => {
      const command = `docker save ${imageToSave.fullName} -o "${outputPath}"`;
      
      exec(command, (error, stdout, stderr) => {
        if (error) {
          spinner.fail(`Failed to save ${imageToSave.fullName}`);
          reject(new Error(`Docker save failed: ${error.message}`));
        } else {
          spinner.succeed(`Saved ${imageToSave.fullName} to ${sanitizedName}`);
          resolve({
            ...imageToSave,
            originalImage: image, // Keep reference to original
            savedPath: outputPath,
            savedName: sanitizedName
          });
        }
      });
    });
  }

  async uploadToAppwrite(savedImage) {
    const spinner = ora(`Uploading ${savedImage.savedName} to Appwrite...`).start();
    
    try {
      // Debug: Check file exists and has content
      const stats = await fs.stat(savedImage.savedPath);
      console.log(`\nFile size: ${stats.size} bytes`);
      
      if (stats.size === 0) {
        throw new Error('File is empty');
      }
      
      const CHUNK_SIZE = 5 * 1024 * 1024; // 5MB chunks as specified by Appwrite
      const fileId = ID.unique();
      const fileBuffer = await fs.readFile(savedImage.savedPath);
      
      console.log(`Generated file ID: ${fileId}`);
      console.log(`File will be uploaded in ${Math.ceil(stats.size / CHUNK_SIZE)} chunk(s)`);
      
      let uploadedFile = null;
      
      // Create progress bar
      const totalChunks = Math.ceil(stats.size / CHUNK_SIZE);
      const progressBar = new cliProgress.SingleBar({
        format: `Uploading ${savedImage.savedName} |{bar}| {percentage}% | {value}/{total} chunks | ETA: {eta}s | Speed: {speed}`,
        barCompleteChar: '\u2588',
        barIncompleteChar: '\u2591',
        hideCursor: true
      });
      
      progressBar.start(totalChunks, 0);
      
      // Upload file in chunks
      for (let start = 0; start < stats.size; start += CHUNK_SIZE) {
        const end = Math.min(start + CHUNK_SIZE, stats.size);
        const chunk = fileBuffer.slice(start, end);
        const chunkNumber = Math.floor(start / CHUNK_SIZE) + 1;
        
        const FormData = require('form-data');
        const fetch = require('node-fetch');
        
        const form = new FormData();
        
        if (start === 0) {
          // First chunk - create the file
          form.append('fileId', fileId);
          form.append('file', chunk, {
            filename: savedImage.savedName,
            contentType: 'application/x-tar'
          });
          // Add permissions as separate form fields (not JSON)
          form.append('permissions[]', 'read("any")');
        } else {
          // Subsequent chunks - append to existing file
          form.append('fileId', fileId);
          form.append('file', chunk, {
            filename: savedImage.savedName,
            contentType: 'application/x-tar'
          });
        }
        
        const endpoint = `${this.appwriteClient.config.endpoint}/storage/buckets/${this.bucketId}/files`;
        
        const headers = {
          'X-Appwrite-Project': this.appwriteClient.config.project,
          'X-Appwrite-Key': this.appwriteClient.config.key,
          'Content-Range': `bytes ${start}-${end-1}/${stats.size}`,
          ...form.getHeaders()
        };
        
        // Add x-appwrite-id header for subsequent chunks
        if (start > 0 && uploadedFile) {
          headers['X-Appwrite-Id'] = uploadedFile.$id;
        }
        
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: headers,
          body: form
        });
        
        if (!response.ok) {
          const errorText = await response.text();
          progressBar.stop();
          throw new Error(`HTTP ${response.status}: ${errorText}`);
        }
        
        const result = await response.json();
        
        if (start === 0) {
          uploadedFile = result;
        }
        
        // Update progress bar
        progressBar.update(chunkNumber);
      }
      
      progressBar.stop();
      spinner.succeed(`Uploaded ${savedImage.savedName} to Appwrite (ID: ${uploadedFile.$id})`);
      return uploadedFile;
      
    } catch (error) {
      spinner.fail(`Failed to upload ${savedImage.savedName}`);
      console.error('Upload error details:', error);
      throw new Error(`Appwrite upload failed: ${error.message}`);
    }
  }

  async cleanup(savedImages) {
    const answers = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'cleanup',
        message: 'Delete local saved image files?',
        default: true
      }
    ]);

    if (answers.cleanup) {
      const spinner = ora('Cleaning up local files...').start();
      
      for (const image of savedImages) {
        try {
          const pathToDelete = image.savedPath || image.localPath;
          if (pathToDelete) {
            await fs.remove(pathToDelete);
          }
        } catch (error) {
          console.log(chalk.yellow(`Warning: Could not delete ${pathToDelete}`));
        }
      }
      
      spinner.succeed('Local files cleaned up');
    }
  }

  async runUploadMode() {
    // Get Docker images
    const images = await this.getDockerImages();
    
    // Let user select images
    const selectedImages = await this.selectImages(images);
    
    if (selectedImages.length === 0) {
      console.log(chalk.yellow('No images selected. Returning to main menu.'));
      return;
    }

    console.log(chalk.blue(`\nProcessing ${selectedImages.length} selected images...\n`));
    
    const savedImages = [];
    const uploadedImages = [];
    const reloadedImages = [];
    
    // Save images locally
    for (const image of selectedImages) {
      try {
        const savedImage = await this.saveDockerImage(image);
        savedImages.push(savedImage);
      } catch (error) {
        console.log(chalk.red(`❌ ${error.message}`));
      }
    }
    
    // Ask if user wants to reload images into Docker
    if (savedImages.length > 0) {
      const reloadAnswer = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'reloadImages',
          message: 'Load the saved images back into Docker?',
          default: true
        }
      ]);

      if (reloadAnswer.reloadImages) {
        console.log(chalk.blue('\nReloading images into Docker...\n'));
        
        // Load images back into Docker
        for (const savedImage of savedImages) {
          try {
            const reloadedImage = await this.loadDockerImage(savedImage);
            reloadedImages.push(reloadedImage);
          } catch (error) {
            console.log(chalk.red(`❌ ${error.message}`));
          }
        }
      }
    }
    
    // Upload to Appwrite
    for (const savedImage of savedImages) {
      try {
        const uploadResult = await this.uploadToAppwrite(savedImage);
        uploadedImages.push({
          ...savedImage,
          uploadResult
        });
      } catch (error) {
        console.log(chalk.red(`❌ ${error.message}`));
      }
    }
    
    // Summary
    console.log(chalk.green.bold(`\n✅ Upload completed!`));
    console.log(chalk.green(`- Images saved: ${savedImages.length}`));
    console.log(chalk.green(`- Images reloaded into Docker: ${reloadedImages.length}`));
    console.log(chalk.green(`- Images uploaded: ${uploadedImages.length}`));
    
    if (uploadedImages.length > 0) {
      console.log(chalk.blue('\nUploaded images:'));
      uploadedImages.forEach(img => {
        console.log(chalk.gray(`  • ${img.fullName} → ${img.uploadResult.$id}`));
      });
    }
    
    if (reloadedImages.length > 0) {
      console.log(chalk.blue('\nReloaded images:'));
      reloadedImages.forEach(img => {
        console.log(chalk.gray(`  • ${img.name || img.fullName}`));
      });
    }
    
    // Cleanup
    if (savedImages.length > 0) {
      await this.cleanup(savedImages);
    }
  }

  async runBulkUploadMode() {
    // Get all Docker images
    const images = await this.getDockerImages();
    
    if (images.length === 0) {
      console.log(chalk.yellow('No Docker images found.'));
      return;
    }

    // Show confirmation for bulk upload
    console.log(chalk.blue(`\nFound ${images.length} Docker images:`));
    images.forEach((img, index) => {
      console.log(chalk.gray(`  ${index + 1}. ${img.fullName} (${img.size})`));
    });

    const confirmAnswer = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'confirm',
        message: `Upload ALL ${images.length} Docker images to Appwrite storage?`,
        default: false
      }
    ]);

    if (!confirmAnswer.confirm) {
      console.log(chalk.yellow('Bulk upload cancelled.'));
      return;
    }

    console.log(chalk.blue(`\n🚀 Starting bulk upload of ${images.length} images...\n`));
    
    const savedImages = [];
    const uploadedImages = [];
    const reloadedImages = [];
    let currentImage = 1;
    
    // Process all images
    for (const image of images) {
      console.log(chalk.blue(`\n[${currentImage}/${images.length}] Processing ${image.fullName}...`));
      
      try {
        // Save image (no tagging prompts in bulk mode)
        const savedImage = await this.saveDockerImage(image, true); // Pass true for bulk mode
        savedImages.push(savedImage);
        
        // Auto-reload into Docker
        try {
          const reloadedImage = await this.loadDockerImage(savedImage);
          reloadedImages.push(reloadedImage);
        } catch (error) {
          console.log(chalk.yellow(`⚠️  Could not reload ${image.fullName}: ${error.message}`));
        }
        
        // Upload to Appwrite
        try {
          const uploadResult = await this.uploadToAppwrite(savedImage);
          uploadedImages.push({
            ...savedImage,
            uploadResult
          });
          console.log(chalk.green(`✅ [${currentImage}/${images.length}] ${image.fullName} completed`));
        } catch (error) {
          console.log(chalk.red(`❌ [${currentImage}/${images.length}] Upload failed for ${image.fullName}: ${error.message}`));
        }
        
      } catch (error) {
        console.log(chalk.red(`❌ [${currentImage}/${images.length}] Save failed for ${image.fullName}: ${error.message}`));
      }
      
      currentImage++;
    }
    
    // Final Summary
    console.log(chalk.green.bold(`\n🎉 Bulk upload completed!`));
    console.log(chalk.green(`- Total images processed: ${images.length}`));
    console.log(chalk.green(`- Images saved: ${savedImages.length}`));
    console.log(chalk.green(`- Images reloaded: ${reloadedImages.length}`));
    console.log(chalk.green(`- Images uploaded: ${uploadedImages.length}`));
    
    if (uploadedImages.length > 0) {
      console.log(chalk.blue(`\n📁 Successfully uploaded ${uploadedImages.length} images:`));
      uploadedImages.forEach(img => {
        console.log(chalk.gray(`  • ${img.fullName} → ${img.uploadResult.$id}`));
      });
    }
    
    const failedUploads = images.length - uploadedImages.length;
    if (failedUploads > 0) {
      console.log(chalk.red(`\n⚠️  ${failedUploads} images failed to upload`));
    }
    
    // Cleanup
    if (savedImages.length > 0) {
      await this.cleanup(savedImages);
    }
  }

  async runDownloadMode() {
    // List files from storage
    const files = await this.listStorageFiles();
    
    // Let user select files to download
    const selectedFiles = await this.selectFilesToDownload(files);
    
    if (selectedFiles.length === 0) {
      console.log(chalk.yellow('No files selected. Returning to main menu.'));
      return;
    }

    console.log(chalk.blue(`\nProcessing ${selectedFiles.length} selected files...\n`));
    
    const downloadedFiles = [];
    const loadedImages = [];
    
    // Download files
    for (const file of selectedFiles) {
      try {
        const downloadedFile = await this.downloadFromAppwrite(file);
        downloadedFiles.push(downloadedFile);
      } catch (error) {
        console.log(chalk.red(`❌ ${error.message}`));
      }
    }
    
    // Load into Docker
    for (const downloadedFile of downloadedFiles) {
      try {
        const loadedImage = await this.loadDockerImage(downloadedFile);
        loadedImages.push(loadedImage);
      } catch (error) {
        console.log(chalk.red(`❌ ${error.message}`));
      }
    }
    
    // Summary
    console.log(chalk.green.bold(`\n✅ Download completed!`));
    console.log(chalk.green(`- Files downloaded: ${downloadedFiles.length}`));
    console.log(chalk.green(`- Images loaded into Docker: ${loadedImages.length}`));
    
    if (loadedImages.length > 0) {
      console.log(chalk.blue('\nLoaded images:'));
      loadedImages.forEach(img => {
        console.log(chalk.gray(`  • ${img.name}`));
      });
    }
    
    // Cleanup
    if (downloadedFiles.length > 0) {
      await this.cleanup(downloadedFiles);
    }
  }

  async runBulkDownloadMode() {
    // List all files from storage
    const files = await this.listStorageFiles();
    
    if (files.length === 0) {
      console.log(chalk.yellow('No files found in Appwrite storage.'));
      return;
    }

    // Show confirmation for bulk download
    console.log(chalk.blue(`\nFound ${files.length} files in storage:`));
    files.forEach((file, index) => {
      console.log(chalk.gray(`  ${index + 1}. ${file.name} (${file.displaySize}) - ${file.displayDate}`));
    });

    const confirmAnswer = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'confirm',
        message: `Download and load ALL ${files.length} Docker images?`,
        default: false
      }
    ]);

    if (!confirmAnswer.confirm) {
      console.log(chalk.yellow('Bulk download cancelled.'));
      return;
    }

    console.log(chalk.blue(`\n⚡ Starting bulk download of ${files.length} files...\n`));
    
    const downloadedFiles = [];
    const loadedImages = [];
    let currentFile = 1;
    
    // Process all files
    for (const file of files) {
      console.log(chalk.blue(`\n[${currentFile}/${files.length}] Processing ${file.name}...`));
      
      try {
        // Download file
        const downloadedFile = await this.downloadFromAppwrite(file);
        downloadedFiles.push(downloadedFile);
        
        // Load into Docker
        try {
          const loadedImage = await this.loadDockerImage(downloadedFile);
          loadedImages.push(loadedImage);
          console.log(chalk.green(`✅ [${currentFile}/${files.length}] ${file.name} completed`));
        } catch (error) {
          console.log(chalk.red(`❌ [${currentFile}/${files.length}] Load failed for ${file.name}: ${error.message}`));
        }
        
      } catch (error) {
        console.log(chalk.red(`❌ [${currentFile}/${files.length}] Download failed for ${file.name}: ${error.message}`));
      }
      
      currentFile++;
    }
    
    // Final Summary
    console.log(chalk.green.bold(`\n🎉 Bulk download completed!`));
    console.log(chalk.green(`- Total files in storage: ${files.length}`));
    console.log(chalk.green(`- Files downloaded: ${downloadedFiles.length}`));
    console.log(chalk.green(`- Images loaded into Docker: ${loadedImages.length}`));
    
    if (loadedImages.length > 0) {
      console.log(chalk.blue(`\n🐳 Successfully loaded ${loadedImages.length} images into Docker:`));
      loadedImages.forEach(img => {
        if (img.dockerOutput) {
          const lines = img.dockerOutput.trim().split('\n');
          const loadedLine = lines.find(line => line.includes('Loaded image:') || line.includes('Loaded image ID:'));
          if (loadedLine) {
            console.log(chalk.gray(`  • ${loadedLine.replace('Loaded image: ', '')}`));
          } else {
            console.log(chalk.gray(`  • ${img.name}`));
          }
        } else {
          console.log(chalk.gray(`  • ${img.name}`));
        }
      });
    }
    
    const failedDownloads = files.length - downloadedFiles.length;
    if (failedDownloads > 0) {
      console.log(chalk.red(`\n⚠️  ${failedDownloads} files failed to download`));
    }

    const failedLoads = downloadedFiles.length - loadedImages.length;
    if (failedLoads > 0) {
      console.log(chalk.red(`\n⚠️  ${failedLoads} downloaded files failed to load into Docker`));
    }
    
    // Cleanup
    if (downloadedFiles.length > 0) {
      await this.cleanup(downloadedFiles);
    }
  }

  async runRemoveMode() {
    // Get Docker images
    const images = await this.getDockerImages();
    
    // Let user select images to remove
    const selectedImages = await this.selectImagesToRemove(images);
    
    if (selectedImages.length === 0) {
      console.log(chalk.yellow('No images selected. Returning to main menu.'));
      return;
    }

    // Safety confirmation
    console.log(chalk.yellow(`\n⚠️  WARNING: You are about to remove ${selectedImages.length} Docker images:`));
    selectedImages.forEach(img => {
      console.log(chalk.gray(`  • ${img.fullName} (${img.size})`));
    });

    const confirmAnswer = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'confirm',
        message: `Are you sure you want to remove these ${selectedImages.length} images?`,
        default: false
      }
    ]);

    if (!confirmAnswer.confirm) {
      console.log(chalk.yellow('Image removal cancelled.'));
      return;
    }

    // Ask about force removal
    const forceAnswer = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'force',
        message: 'Force remove images (removes even if used by containers)?',
        default: false
      }
    ]);

    console.log(chalk.blue(`\n🗑️ Removing ${selectedImages.length} Docker images...\n`));
    
    const removedImages = [];
    const failedRemovals = [];
    
    // Remove images
    for (const image of selectedImages) {
      try {
        const removedImage = await this.removeDockerImage(image, forceAnswer.force);
        removedImages.push(removedImage);
      } catch (error) {
        console.log(chalk.red(`❌ ${error.message}`));
        failedRemovals.push({
          image,
          error: error.message
        });
      }
    }
    
    // Summary
    console.log(chalk.green.bold(`\n✅ Image removal completed!`));
    console.log(chalk.green(`- Images selected: ${selectedImages.length}`));
    console.log(chalk.green(`- Images removed: ${removedImages.length}`));
    console.log(chalk.red(`- Failed removals: ${failedRemovals.length}`));
    
    if (removedImages.length > 0) {
      console.log(chalk.blue('\n🗑️ Successfully removed images:'));
      removedImages.forEach(img => {
        console.log(chalk.gray(`  • ${img.fullName}`));
      });
    }
    
    if (failedRemovals.length > 0) {
      console.log(chalk.red('\n⚠️ Failed to remove:'));
      failedRemovals.forEach(failure => {
        console.log(chalk.red(`  • ${failure.image.fullName}: ${failure.error}`));
      });
      
      if (!forceAnswer.force && failedRemovals.some(f => f.error.includes('being used by'))) {
        console.log(chalk.yellow('\n💡 Tip: Try using force removal for images used by containers.'));
      }
    }
  }

  async runNuclearCleanupMode() {
    console.log(chalk.red.bold('\n💥 NUCLEAR CLEANUP MODE'));
    console.log(chalk.red('This will completely clean up your Docker environment and start fresh.\n'));
    
    // Show what will be removed
    console.log(chalk.yellow('This operation will:'));
    console.log(chalk.gray('  • Stop ALL running containers'));
    console.log(chalk.gray('  • Remove ALL containers (running and stopped)'));
    console.log(chalk.gray('  • Remove ALL Docker images'));
    console.log(chalk.gray('  • Remove ALL Docker volumes'));
    console.log(chalk.gray('  • Remove ALL custom Docker networks'));
    console.log(chalk.gray('  • Leave only default networks (bridge, host, none, ingress)'));
    
    // Check Docker permissions first
    console.log(chalk.blue('\n🔍 Checking Docker permissions...'));
    try {
      execSync('docker ps', { stdio: 'ignore' });
      console.log(chalk.green('✅ Docker access confirmed'));
    } catch (error) {
      console.log(chalk.red('❌ Docker permission denied!'));
      console.log(chalk.yellow('\nTo fix this, run one of these commands:'));
      console.log(chalk.gray('  • sudo usermod -aG docker $USER (then log out and back in)'));
      console.log(chalk.gray('  • sudo chmod 666 /var/run/docker.sock'));
      console.log(chalk.gray('  • Or run this script with sudo: sudo npm start'));
      console.log(chalk.yellow('\nAfter fixing permissions, run this script again.'));
      return;
    }
    
    // Get current Docker state for confirmation
    let containerCount = 0;
    let imageCount = 0;
    let volumeCount = 0;
    let networkCount = 0;
    
    try {
      // Count containers
      const containersOutput = execSync('docker ps -aq', { encoding: 'utf8' });
      containerCount = containersOutput.trim().split('\n').filter(line => line.length > 0).length;
      
      // Count images
      const imagesOutput = execSync('docker images -q', { encoding: 'utf8' });
      imageCount = imagesOutput.trim().split('\n').filter(line => line.length > 0).length;
      
      // Count volumes
      const volumesOutput = execSync('docker volume ls -q', { encoding: 'utf8' });
      volumeCount = volumesOutput.trim().split('\n').filter(line => line.length > 0).length;
      
      // Count custom networks (excluding default ones)
      const networksOutput = execSync('docker network ls | grep -vE "bridge|host|none|ingress" | awk "{print $1}"', { encoding: 'utf8' });
      networkCount = networksOutput.trim().split('\n').filter(line => line.length > 0).length;
      
    } catch (error) {
      console.log(chalk.red(`❌ Error checking Docker state: ${error.message}`));
      console.log(chalk.yellow('Please check your Docker installation and permissions.'));
      return;
    }
    
    if (containerCount > 0 || imageCount > 0 || volumeCount > 0 || networkCount > 0) {
      console.log(chalk.blue(`\nCurrent Docker state:`));
      console.log(chalk.gray(`  • Containers: ${containerCount}`));
      console.log(chalk.gray(`  • Images: ${imageCount}`));
      console.log(chalk.gray(`  • Volumes: ${volumeCount}`));
      console.log(chalk.gray(`  • Custom networks: ${networkCount}`));
    } else {
      console.log(chalk.green('\n✅ Docker environment is already clean!'));
      return;
    }
    
    // Multiple confirmations for safety
    const confirm1 = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'confirm1',
        message: 'Are you ABSOLUTELY sure you want to perform nuclear cleanup?',
        default: false
      }
    ]);
    
    if (!confirm1.confirm1) {
      console.log(chalk.yellow('Nuclear cleanup cancelled.'));
      return;
    }
    
    const confirm2 = await inquirer.prompt([
      {
        type: 'input',
        name: 'confirm2',
        message: 'Type "NUCLEAR" to confirm (case sensitive):',
        validate: input => input === 'NUCLEAR' || 'Please type "NUCLEAR" exactly to confirm'
      }
    ]);
    
    if (confirm2.confirm2 !== 'NUCLEAR') {
      console.log(chalk.yellow('Nuclear cleanup cancelled.'));
      return;
    }
    
    console.log(chalk.red.bold('\n💥 Starting nuclear cleanup...\n'));
    
    const results = {
      containers: { stopped: 0, removed: 0 },
      images: { removed: 0 },
      volumes: { removed: 0 },
      networks: { removed: 0 },
      errors: []
    };
    
    // Step 1: Stop all containers
    console.log(chalk.blue('1️⃣ Stopping all containers...'));
    try {
      const stopOutput = execSync('docker stop $(docker ps -q) 2>/dev/null || true', { encoding: 'utf8' });
      const stoppedContainers = stopOutput.trim().split('\n').filter(line => line.length > 0);
      results.containers.stopped = stoppedContainers.length;
      console.log(chalk.green(`   ✅ Stopped ${results.containers.stopped} containers`));
    } catch (error) {
      console.log(chalk.yellow(`   ⚠️  No running containers to stop`));
    }
    
    // Step 2: Remove all containers
    console.log(chalk.blue('2️⃣ Removing all containers...'));
    try {
      const removeOutput = execSync('docker rm -f $(docker ps -aq) 2>/dev/null || true', { encoding: 'utf8' });
      const removedContainers = removeOutput.trim().split('\n').filter(line => line.length > 0);
      results.containers.removed = removedContainers.length;
      console.log(chalk.green(`   ✅ Removed ${results.containers.removed} containers`));
    } catch (error) {
      console.log(chalk.yellow(`   ⚠️  No containers to remove`));
    }
    
    // Step 3: Remove all images
    console.log(chalk.blue('3️⃣ Removing all Docker images...'));
    try {
      const removeImagesOutput = execSync('docker rmi -f $(docker images -q) 2>/dev/null || true', { encoding: 'utf8' });
      const removedImages = removeImagesOutput.trim().split('\n').filter(line => line.length > 0);
      results.images.removed = removedImages.length;
      console.log(chalk.green(`   ✅ Removed ${results.images.removed} images`));
    } catch (error) {
      console.log(chalk.yellow(`   ⚠️  No images to remove`));
    }
    
    // Step 4: Remove all volumes
    console.log(chalk.blue('4️⃣ Removing all Docker volumes...'));
    try {
      const removeVolumesOutput = execSync('docker volume rm $(docker volume ls -q) 2>/dev/null || true', { encoding: 'utf8' });
      const removedVolumes = removeVolumesOutput.trim().split('\n').filter(line => line.length > 0);
      results.volumes.removed = removedVolumes.length;
      console.log(chalk.green(`   ✅ Removed ${results.volumes.removed} volumes`));
    } catch (error) {
      console.log(chalk.yellow(`   ⚠️  No volumes to remove`));
    }
    
    // Step 5: Remove custom networks
    console.log(chalk.blue('5️⃣ Removing custom Docker networks...'));
    try {
      const removeNetworksOutput = execSync('docker network rm $(docker network ls | grep -vE "bridge|host|none|ingress" | awk "{print $1}") 2>/dev/null || true', { encoding: 'utf8' });
      const removedNetworks = removeNetworksOutput.trim().split('\n').filter(line => line.length > 0);
      results.networks.removed = removedNetworks.length;
      console.log(chalk.green(`   ✅ Removed ${results.networks.removed} custom networks`));
    } catch (error) {
      console.log(chalk.yellow(`   ⚠️  No custom networks to remove`));
    }
    
    // Final verification
    console.log(chalk.blue('\n6️⃣ Verifying cleanup...'));
    let finalContainerCount = 0;
    let finalImageCount = 0;
    let finalVolumeCount = 0;
    let finalNetworkCount = 0;
    
    try {
      const finalContainersOutput = execSync('docker ps -aq', { encoding: 'utf8' });
      finalContainerCount = finalContainersOutput.trim().split('\n').filter(line => line.length > 0).length;
      
      const finalImagesOutput = execSync('docker images -q', { encoding: 'utf8' });
      finalImageCount = finalImagesOutput.trim().split('\n').filter(line => line.length > 0).length;
      
      const finalVolumesOutput = execSync('docker volume ls -q', { encoding: 'utf8' });
      finalVolumeCount = finalVolumesOutput.trim().split('\n').filter(line => line.length > 0).length;
      
      const finalNetworksOutput = execSync('docker network ls | grep -vE "bridge|host|none|ingress" | awk "{print $1}"', { encoding: 'utf8' });
      finalNetworkCount = finalNetworksOutput.trim().split('\n').filter(line => line.length > 0).length;
      
    } catch (error) {
      console.log(chalk.gray('Could not verify final state'));
    }
    
    // Summary
    console.log(chalk.green.bold('\n🎉 Nuclear cleanup completed!'));
    console.log(chalk.green(`- Containers stopped: ${results.containers.stopped}`));
    console.log(chalk.green(`- Containers removed: ${results.containers.removed}`));
    console.log(chalk.green(`- Images removed: ${results.images.removed}`));
    console.log(chalk.green(`- Volumes removed: ${results.volumes.removed}`));
    console.log(chalk.green(`- Custom networks removed: ${results.networks.removed}`));
    
    console.log(chalk.blue('\nFinal Docker state:'));
    console.log(chalk.gray(`  • Containers: ${finalContainerCount}`));
    console.log(chalk.gray(`  • Images: ${finalImageCount}`));
    console.log(chalk.gray(`  • Volumes: ${finalVolumeCount}`));
    console.log(chalk.gray(`  • Custom networks: ${finalNetworkCount}`));
    
    if (finalContainerCount === 0 && finalImageCount === 0 && finalVolumeCount === 0 && finalNetworkCount === 0) {
      console.log(chalk.green.bold('\n✅ Docker environment is now completely clean!'));
      console.log(chalk.blue('You can now start fresh with your deployments.'));
    } else {
      console.log(chalk.yellow('\n⚠️  Some items may still exist (possibly in use or protected)'));
    }
  }

  async run() {
    try {
      await this.init();
      
      // Get Appwrite mode
      const mode = await this.chooseMode();
      
      if (mode === 'exit') {
        console.log(chalk.yellow('Exiting Docker Image Manager.'));
        return;
      }

      // Setup Appwrite for storage access (not needed for remove mode or nuclear cleanup)
      if (mode !== 'remove' && mode !== 'nuclear-cleanup') {
        await this.setupAppwrite();
      }

      if (mode === 'upload') {
        await this.runUploadMode();
      } else if (mode === 'bulk-upload') {
        await this.runBulkUploadMode();
      } else if (mode === 'download') {
        await this.runDownloadMode();
      } else if (mode === 'bulk-download') {
        await this.runBulkDownloadMode();
      } else if (mode === 'remove') {
        await this.runRemoveMode();
      } else if (mode === 'nuclear-cleanup') {
        await this.runNuclearCleanupMode();
      }
      
    } catch (error) {
      console.error(chalk.red(`\n❌ Error: ${error.message}`));
      process.exit(1);
    }
  }
}

// Check if Docker is available
try {
  execSync('docker --version', { stdio: 'ignore' });
} catch (error) {
  console.error(chalk.red('❌ Docker is not installed or not accessible.'));
  console.error(chalk.gray('Make sure Docker is installed and running.'));
  process.exit(1);
}

// Check Docker permissions
try {
  execSync('docker ps', { stdio: 'ignore' });
} catch (error) {
  console.error(chalk.red('❌ Docker permission denied!'));
  console.error(chalk.yellow('\nTo fix this, run one of these commands:'));
  console.error(chalk.gray('  • sudo usermod -aG docker $USER (then log out and back in)'));
  console.error(chalk.gray('  • sudo chmod 666 /var/run/docker.sock'));
  console.error(chalk.gray('  • Or run this script with sudo: sudo npm start'));
  console.error(chalk.yellow('\nAfter fixing permissions, run this script again.'));
  process.exit(1);
}

// Run the application
const manager = new DockerImageManager();
manager.run().catch(error => {
  console.error(chalk.red(`\n❌ Unexpected error: ${error.message}`));
  process.exit(1);
}); 