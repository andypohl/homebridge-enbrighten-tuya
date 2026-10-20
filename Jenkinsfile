// CI/CD for homebridge-enbrighten-tuya.
//
// Runs on a Jenkins instance local to the Homebridge host (homebridgerton):
// validate the plugin, then on `main` deploy it via tools/deploy.sh — which
// installs a self-contained copy into the separate /var/lib/homebridge/custom
// dir and restarts Homebridge.
//
// Door left open for GitHub Actions later (when publishing to homebridge.io):
// the same tools/deploy.sh (or an `npm publish`) can be driven from a workflow.
pipeline {
  agent any
  options { timestamps() }
  environment {
    // Homebridge's bundled Node, so CI uses the same runtime as production.
    PATH = "/opt/homebridge/bin:${env.PATH}"
    NPM_CLI = "/opt/homebridge/lib/node_modules/npm/bin/npm-cli.js"
  }
  stages {
    stage('Checkout') {
      steps { checkout scm }
    }
    stage('Validate') {
      steps {
        sh 'node --version'
        sh 'node --check index.js'
        sh 'node --check tools/local_test.js'
        // Pack dry-run confirms packaging is valid and secrets are excluded.
        sh 'node "$NPM_CLI" pack --dry-run'
      }
    }
    stage('Deploy') {
      when { branch 'main' }
      steps {
        // deploy.sh needs root (writes under /var/lib/homebridge, restarts service).
        // Jenkins is granted scoped passwordless sudo for exactly this script.
        sh 'sudo /bin/bash "$WORKSPACE/tools/deploy.sh" "$WORKSPACE"'
      }
    }
  }
  post {
    success { echo 'homebridge-enbrighten-tuya validated (and deployed on main).' }
    failure { echo 'Pipeline failed — Homebridge was not updated.' }
  }
}
