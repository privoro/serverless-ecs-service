
'use strict';
// https://gist.github.com/bwinant/406b7cf1677ba63896f5253d07d01f37
const git = require('git-rev-sync');
const path = require('path');
const dockerCLI = require('docker-cli-js');
const DockerOptions = dockerCLI.Options;
const Docker = dockerCLI.Docker;
const Promise = require('bluebird');
const { execSync } = require('child_process');
const _ = require('lodash');
const Resources = require('./resources');
const {ConfigFactory} = require('./config');
const {tryAll} = require('./lib/tryAll');


class ServerlessPlugin {
  constructor(serverless, options) {
    this.serverless = serverless;
    this.options = options;
    this.commands = {
      'clean-registry': {
        usage: 'Removes the ECR repository (and all of its images) created by the plugin for this service',
        lifecycleEvents: [
          'delete'
        ]
      },

      'ecs-run-local': {
        usage: 'Runs ECS server locally',
        lifecycleEvents: [
          'run-local'
        ],
      },

      'ecs-build': {
        usage: 'Build container images',
        lifecycleEvents: [
          'build'
        ],
      }
    };

    this.hooks = {
      'clean-registry:delete': this.removeRepositories.bind(this),
      'before:package:createDeploymentArtifacts': this.setupEcr.bind(this),
      'package:createDeploymentArtifacts': this.buildAllImages.bind(this),
      'after:package:createDeploymentArtifacts': this.pushImageToEcr.bind(this),
      'before:package:finalize': this.addCustomResources.bind(this),
      'remove:remove': this.removeService.bind(this),
      'before:ecs-run-local:run-local': this.buildImageByName.bind(this),
      'ecs-run-local:run-local': this.runImage.bind(this),
      'ecs-build:build': this.buildAllImages.bind(this)
    };
  }

  getConfig() {
    return ConfigFactory(this.serverless.service.custom['serverless-ecs-service']);
  }

  getDocker(cwd) {
    let options = Object.assign({}, DockerOptions, {
      currentWorkingDirectory: cwd
    });
    return new Docker(options);
  }

  getAws() {
    if(! this.serverless.providers.aws) {
      throw new Error('serverless-ecs-service only works with the aws provider');
    }
    return this.serverless.providers.aws.sdk || null;
  }

  getECR() {
    let aws = this.getAws();
    return new aws.ECR({region: this.options.region});
  }

  getTag() {
    let tag;
    try {
      tag = git.short(this.serverless.config.servicePath);
      if(git.isDirty()) {
        tag += '-dirty'
      }
    } catch(err){
      console.log(`git-rev-sync failed: ${err}`);
      tag = process.env.CODEBUILD_RESOLVED_SOURCE_VERSION || 'unknown';

    }
    return tag;
  }

  getRepoUrl(container, latest = false) {
    let config = this.getConfig();
    let name = this.getImageName(container.name);
    let tag = latest ? 'latest' : this.getTag();

    return `${config.ecr['aws-account-id']}.dkr.ecr.${this.options.region}.amazonaws.com/${name}:${tag}`;
  }

  getImageName(containerName) {
    let config = this.getConfig();
    let parts = [containerName];
    if(config.ecr.namespace) {
      parts.unshift(config.ecr.namespace);
    }
    return parts.join('/').toLowerCase();
  }

  getDockerPath(container) {
    let config = this.getConfig();
    return (container||{}).contextDir || config['contextDir'];
  }

  setupEcr() {
    return tryAll(() => this.getConfig(), () => this.getAws())
      .then(results=> {
        let [config, aws] = results;

        let ecr = this.getECR();

        return Promise.each(config.containers, container => {
          let repoName = this.getImageName(container.name);

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
      })
      .catch(e =>
        this.serverless.cli.log(
          `Skipping setup ecr: ${e.message}`));
  }

  buildAllImages() {
    let config = this.getConfig();
    if(config === null) {
      this.serverless.cli.log(`serverless-ecs-service config not provided. Skipping build image`);
      return;
    }
    return Promise.each(config.containers, (container => this.buildImage(container)));
  }

  getContainerByName(name){
    let config = this.getConfig();
    return config.containers.find(container => container.name === name);
  }

  buildImageByName(){
    let name = this.options.containerName;
    if(!name){
      this.serverless.cli.log("option containerName is required to build image");
      return;
    }
    let container = this.getContainerByName(name);
    return this.buildImage(container);
  }

  buildImage(container){
    let config = this.getConfig();
    let tag = this.getTag();
    let dockerPath = this.getDockerPath(container);
    let docker = this.getDocker(dockerPath);
    let name = this.getImageName(container.name);
    let repoUrl = this.getRepoUrl(container);
    let repoUrlLatest = this.getRepoUrl(container,true);
    let dockerFilepath = path.resolve(
        path.resolve(container.contextDir || config.contextDir),
        container['docker-dir'] || this.serverless.config.servicePath,
        container['dockerFile'] || 'Dockerfile'
    );

    let nocache = (config.nocache||"").toLowerCase() === 'true' ? '--no-cache=true':'';

    this.serverless.cli.log(`Building image ${name} ...`);
    // --no-cache=true
    return docker.command(`build --tag ${name}:${tag} --tag ${name}:latest --file ${dockerFilepath} .`)
        .then( async (result) => {
          for(let i = result.response.length-3; i < result.response.length; i++) {
            if(result.response[i] === '') { continue; }
            this.serverless.cli.log(result.response[i]);
          }

          this.serverless.cli.log(`Built image ${name}.`);

          await docker.command(`tag ${name}:${tag} ${repoUrl}`)
          await docker.command(`tag ${name}:${tag} ${repoUrlLatest}`)
          this.serverless.cli.log(`Tagged image for ECR`);

        }).catch(err => {
          this.serverless.cli.log(`Failed to build image.`);
          this.serverless.cli.log(err.stdout);
          this.serverless.cli.log(err.stderr);
          this.serverless.cli.log(err);
        });
  }

  runImage() {
    let dockerPath = this.getDockerPath();
    let docker = this.getDocker(dockerPath);
    let name = this.options.containerName;
    let tag = this.getTag();

    if(!name){
      this.serverless.cli.log("option containerName is required to run image");
      return;
    }
    name = this.getImageName(name);
    let envVars = this.serverless.service.provider.environment || [];
    let runVars = [];
    _.forOwn(envVars, (value, key) => runVars.push(`-e ${key}="${value}"`));
    return docker.command(`run ` + runVars.join(" ") + ` ${name}:${tag}`);
  }

  async pushImageToEcr() {
    // push previously built image to ecr
    let config = this.getConfig();
    if(config === null) {
      this.serverless.cli.log(`serverless-ecs-service config not provided. Skipping build image`);
      return;
    }

    try {
      execSync(`$(aws ecr get-login --no-include-email --region ${this.options.region}) | docker login --username AWS --password-stdin ${this.config.Ecr.AwsAccountId}.dkr.ecr.${this.options.region}.amazonaws.com`);
      this.serverless.cli.log(`Successfully configured docker with ECR credentials`);
    } catch (err) {
      this.serverless.cli.log(`Failed to configure docker with ECR credentials (using aws cli v1): ${err.message}`);
      // try aws cli v2 version
      //$(aws ecr get-login --no-include-email --region us-west-2)
      try {
        execSync(`$(aws ecr get-login-password --region ${this.options.region}) | docker login --username AWS --password-stdin ${this.config.Ecr.AwsAccountId}.dkr.ecr.${this.options.region}.amazonaws.com`);
        this.serverless.cli.log(`Successfully configured docker with ECR credentials`);
      } catch (err) {
        this.serverless.cli.log(`Failed to configure docker with ECR credentials (using aws cli v2): ${err.message}`);
        throw err; // dont let serverless keep deploying
      }
    }

    this.serverless.cli.log(`Will push artifacts to ECR`);

    return Promise.each(config.containers, async container => {
      let repoUrl = this.getRepoUrl(container);
      let latestRepoUrl = this.getRepoUrl(container, true);
      let dockerPath = this.getDockerPath(container);
      let docker = this.getDocker(dockerPath);
      try {
        this.serverless.cli.log(`Pushing ${repoUrl} to ECR....`);
        // push :build tag
        await docker.command(`push ${repoUrl}`)
        this.serverless.cli.log(`Successfully pushed ${repoUrl} to ECR.`);
      } catch (err) {
        this.serverless.cli.log(`Failed to push ${repoUrl} to ECR: ${err}.`);
        this.serverless.cli.log(`You probably need to configure docker with your ecr credentials`);
        throw err // dont let serverless keep deploying
      }

      try {
        // push :latest tag
        await docker.command(`push ${latestRepoUrl}`)
        this.serverless.cli.log(`Successfully pushed ${latestRepoUrl} to ECR.`);
      } catch (err) {
        this.serverless.cli.log(`Failed to push ${latestRepoUrl} to ECR: ${err}.`);
        this.serverless.cli.log(`You probably need to configure docker with your ecr credentials`);
        throw err // dont let serverless keep deploying
      }
    });
  }

  addResource(resource) {
    _.merge(this.serverless.service.provider.compiledCloudFormationTemplate.Resources, resource);
  }

  addOutput(output) {
    _.merge(this.serverless.service.provider.compiledCloudFormationTemplate.Outputs, output);
    /*
      Outputs:
    NewServiceExport:
      Value: 'A Value To Export'
      Export:
        Name: ${self:custom.exportName}
     */
  }

  addCustomResources() {
    let config = this.getConfig();
    if (config === null) {
      this.serverless.cli.log(`serverless-ecs-service config not provided.`);
      return;
    }

    let tag = this.getTag();
    this.serverless.cli.log(`Add custom resources ...`);

    let hasIngress = (config.containers || []).filter(c => !!c.path).length > 0;

    let resources = Resources(this.serverless.service, config, this.options);
    // shared resources
    // log group
    (config.containers ||[]).map(container => {
      this.addResource(resources.LogGroup(container));
    })
    //this.addResource(resources.LogGroup());
    if(hasIngress) {
      this.addResource(resources.Route53CName());
      this.addResource(resources.Route53AAlias());
    }
    this.addResource(resources.EcsTaskExecutionRole(config.containers));
    // use same task role for all services (for now)
    this.addResource(resources.EcsTaskRole(config.containers));
    (config.containers ||[]).map(container => {
      this.addResource(resources.EcsTaskDefinition(container,tag));
      this.addResource(resources.EcsService(container, tag));
    })
    // this.addResource(resources.EcsTaskDefinition(config.containers,tag));
    // this.addResource(resources.EcsService(config.containers, tag));

    if(hasIngress) {
      this.addResource(resources.ApiGatewayRestApi());
      this.addResource(resources.ApiGatewayCustomDomain());
      this.addResource(resources.ApiGatewayBasePathMapping());
    }

    // service specific resources
    return Promise.each(config.containers, (container, index) => {
      let path = container.path;
      if(!path) { return }

      this.addResource(resources.TargetGroup(container, 'HTTP'));
      this.addResource(resources.ListenerRule(container, index+1));


      this.addResource(resources.ApiGatewayResource(path, container.name));
      this.addResource(resources.ApiGatewayPathMethod(container.name, path, false));
      this.addResource(resources.ApiGatewayProxyResource(container.name, false));
      this.addResource(resources.ApiGatewayProxyMethod(container.name, path, false));
    }).then(() => {
      let apiMethods = Object.keys(this.serverless.service.provider.compiledCloudFormationTemplate.Resources).filter((a)=> a.indexOf('RootMethod') !== -1 || a.indexOf('PathMethod') !== -1 || a.indexOf('ProxyMethod') !== -1);
      // add a deployment
      if(hasIngress){
        this.addResource(resources.ApiGatewayStage(config.containers, apiMethods));
      }
      // TODO debug created resources
      // this.serverless.service.provider.compiledCloudFormationTemplate.Resources
    });

  }


  removeService(){}

  removeRepositories() {
    let config = this.getConfig();
    if(config === null) {
      this.serverless.cli.log(`serverless-ecs-service config not provided. Skipping remove service`);
      return;
    }

    let ecr = this.getECR();
    return Promise.each(config.containers, container => {
      let repositoryName = this.getImageName(container.name);
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

}

module.exports = ServerlessPlugin;
