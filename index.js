'use strict';
// https://gist.github.com/bwinant/406b7cf1677ba63896f5253d07d01f37
const git = require('git-rev-sync');
const path = require('path');
const dockerCLI = require('docker-cli-js');
const DockerOptions = dockerCLI.Options;
const Docker = dockerCLI.Docker;
const Promise = require('bluebird');
const { execSync } = require('child_process');

const pre = 'ecs-service';

class ServerlessPlugin {
  constructor(serverless, options) {
    this.serverless = serverless;
    this.options = options;

    this.commands = {
      welcome: {
        usage: 'Helps you start your first Serverless plugin',
        lifecycleEvents: [
          'hello',
          'world',
        ],
        options: {
          message: {
            usage:
              'Specify the message you want to deploy '
              + '(e.g. "--message \'My Message\'" or "-m \'My Message\'")',
            required: true,
            shortcut: 'm',
          },
        },
      },

      'clean-registry': {
        usage: 'Removes the ECR repository (and all of its images) created by the plugin for this service',
        lifecycleEvents: [
          'delete'
        ]
      }
    };

    this.hooks = {
      'before:welcome:hello': this.beforeWelcome.bind(this),
      'welcome:hello': this.welcomeUser.bind(this),
      'welcome:world': this.displayHelloMessage.bind(this),
      'after:welcome:world': this.afterHelloWorld.bind(this),

      'clean-registry:delete': this.removeRepositories.bind(this),

      'before:package:createDeploymentArtifacts': this.setupEcr.bind(this),
      'package:createDeploymentArtifacts': this.buildImage.bind(this),
      'after:package:createDeploymentArtifacts': this.pushImageToEcr.bind(this),
      'before:package:finalize': this.addCustomResources.bind(this),
      'rollback:rollback': this.rollbackService.bind(this),
      'remove:remove': this.removeService.bind(this)
    };
  }

  getConfig() {
    return this.serverless.service.custom['serverless-ecs-service'] || null;
  }

  getDocker(cwd) {
    let options = Object.assign({}, DockerOptions, {
      currentWorkingDirectory: cwd
    });
    return new Docker(options);
  }

  getAws() {
    if(! this.serverless.providers.aws) { return null; }
    return this.serverless.providers.aws.sdk || null;
  }

  getECR() {
    let aws = this.getAws();
    return new aws.ECR({region: this.options.region});
  }

  getTag() {
    let tag = git.short(this.serverless.config.servicePath);
    if(git.isDirty()) {
      tag += '-dirty'
    }
    return tag;
  }

  getRepoUrl(service) {
    let config = this.getConfig();
    let name = this.getRepositoryName(service);
    let tag = this.getTag();

    return `${config.ecr['aws-account-id']}.dkr.ecr.${this.options.region}.amazonaws.com/${name}:${tag}`;
    //docker tag neo4j-dev:latest 492058901556.dkr.ecr.us-west-2.amazonaws.com/neo4j-dev:latest

    //Run the following command to push this image to your newly created AWS repository:
     // docker push 492058901556.dkr.ecr.us-west-2.amazonaws.com/neo4j-dev:latest
  }

  getRepositoryName(service) {
    let config = this.getConfig();
    let parts = [service.name];
    if(config.ecr.namespace) {
      parts.unshift(config.ecr.namespace);
    }
    return parts.join('/');
  }

  getDockerPath(service) {
    return path.resolve(this.serverless.config.servicePath, service['docker-dir'] || './')
  }

  setupEcr() {
    let config = this.getConfig();
    if(config === null) {
      this.serverless.cli.log(`serverless-ecs-service config not provided. Skipping build image`);
      return;
    }

    let aws = this.getAws();
    if(aws === null) {
      this.serverless.cli.log(`serverless-ecs-service only works with the aws provider`);
      return;
    }

    let ecr = this.getECR();

    return Promise.each(config.services, service => {
      let repoName = this.getRepositoryName(service);

      let params = {
        registryId: config.ecr.registry,
        repositoryNames: [
          repoName
        ]
      };

      return ecr.describeRepositories(params).promise()
        .then(data => {
          this.serverless.cli.log(`√ Repository ${repoName} already exists ...`)
        }).catch(err => {
          if(err.statusCode !== 400) {
            throw err;
          }
          // repo not found, create it
          let createParams = {
            repositoryName: repoName
          };

          return ecr.createRepository(createParams).promise()
            .then(data => {
              this.serverless.cli.log(`√ Created Repository ${data.repository.repositoryName} : ${data.repository.repositoryArn} ...`);
              return;
            });
        });
    });

  }

  buildImage() {
    let config = this.getConfig();
    if(config === null) {
      this.serverless.cli.log(`serverless-ecs-service config not provided. Skipping build image`);
      return;
    }

    let tag = this.getTag();

    return Promise.each(config.services, (service => {
      let dockerPath = this.getDockerPath(service);
      let docker = this.getDocker(dockerPath);
      let name = this.getRepositoryName(service);
      let repoUrl = this.getRepoUrl(service);

      this.serverless.cli.log(`Building image ${name} ...`);
      return docker.command(`build -t ${name}:${tag} .`)
        .then( (result) => {
          for(let i = result.response.length-3; i < result.response.length; i++) {
            if(result.response[i] === '') { continue; }
            this.serverless.cli.log(result.response[i]);
          }

          this.serverless.cli.log(`Built image ${name}.`);

          return docker.command(`tag ${name}:${tag} ${repoUrl}`)
            .then(result => {
              this.serverless.cli.log(`Tagged image for ECR`);
            });
        }).catch(err => {
          this.serverless.cli.log(`Failed to build image.`);
          this.serverless.cli.log(err);
        });

    }));
  }

  pushImageToEcr() {
    // push previously built image to ecr
    let config = this.getConfig();
    if(config === null) {
      this.serverless.cli.log(`serverless-ecs-service config not provided. Skipping build image`);
      return;
    }

    try {
      execSync(`$(aws ecr get-login --no-include-email --region ${this.options.region})`);
      this.serverless.cli.log(`Successfully configured docker with ECR credentials`);
    } catch (err) {
      this.serverless.cli.log(`Failed to configure docker with ECR credentials: ${err.message}`);
    }

    return Promise.each(config.services, service => {
      let repoUrl = this.getRepoUrl(service);
      let dockerPath = this.getDockerPath(service);
      let docker = this.getDocker(dockerPath);
      return docker.command(`push ${repoUrl}`)
        .then(() => {
          this.serverless.cli.log(`Successfully pushed ${repoUrl} to ECR.`);
        }).catch(err => {
          this.serverless.cli.log(`Failed to push ${repoUrl} to ECR: ${err}.`);
          this.serverless.cli.log(`You probably need to configure docker with your ecr credentials`);
        })
    });
  }

  addCustomResources() {
    // TODO
    // add cloudformation resources to describe ECS service
    // ECSTaskExecutionRole
    // add ECR Repository for images
    // add Service definition
      // load balance target group
    // add task definition
    // add api gateway http integration -> forward to load balanced service
    // cloud watch log group
  }

  rollbackService() {
    // perhaps this is not necessary
    // if we're using the cf resource to define the container + img
  }

  removeService(){}

  removeRepositories() {
    let config = this.getConfig();
    if(config === null) {
      this.serverless.cli.log(`serverless-ecs-service config not provided. Skipping remove service`);
      return;
    }

    let ecr = this.getECR();
    return Promise.each(config.services, service => {
      let repositoryName = this.getRepositoryName(service);
      let params = {
        force: true,
        repositoryName
      };
      return ecr.deleteRepository(params).promise()
        .then(() => {
          this.serverless.cli.log(`Successfully deleted repository ${repositoryName}`);
        });
    });

  }

  beforeWelcome() {
    this.serverless.cli.log('Hello from Serverless!');
  }

  welcomeUser() {
    this.serverless.cli.log('Your message:');
  }

  displayHelloMessage() {
    this.serverless.cli.log(`${this.options.message}`);
  }

  afterHelloWorld() {
    this.serverless.cli.log('Please come again!');
  }
}

module.exports = ServerlessPlugin;
