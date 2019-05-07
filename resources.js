module.exports = (serverlessService, config, options) => {
  let slsServiceName = serverlessService.service;
  return {
    LogGroup: () => ({
      'LogGroup': {
        Type: 'AWS::Logs::LogGroup',
        Properties: {
          LogGroupName: `${slsServiceName}-ecs-service`
        }
      }
    }),

    EcsService: () => ({
      'ECSService': {
        Type: 'AWS::ECS::Service',
        Properties: {
          Cluster: config.cluster,
          LaunchType: 'FARGATE',
          DeploymentConfiguration: {
            MaximumPercent: 200,
            MinimumHealthyPercent: 50
          },
          DesiredCount: config.scale,
          //HealthCheckGracePeriodSeconds: 120,
          NetworkConfiguration: {
            AwsvpcConfiguration: {
              AssignPublicIp: 'ENABLED',
              SecurityGroups: config.vpc['security-groups'] || [],
              Subnets: config.vpc.subnets || []
            }
          },
          SchedulingStrategy: 'REPLICA',
          ServiceName: `${slsServiceName}`,
          TaskDefinition: { Ref: 'TaskDefinition' }
        }
      },
    }),

    EcsTaskDefinition: (containers, tag) => {
      let getImageName = (container) => {
        let parts = [container.name];
        if(config.ecr.namespace) {
          parts.unshift(config.ecr.namespace);
        }
        return parts.join('/') + `:${tag}`;
      };

      let getRepoUrl = (container) => {
        let name = getImageName(container);

        return `${config.ecr['aws-account-id']}.dkr.ecr.${options.region}.amazonaws.com/${name}`;
      }

      let containerDefinitions = containers.map(container => ({
        Essential: true,
        Image: getRepoUrl(container),
        Name: container.name,
        Environment: [],
        PortMappings: (container.ports || []).map(p => ({ContainerPort: p})),
        ReadonlyRootFilesystem: true,
        LogConfiguration: {
          LogDriver: 'awslogs',
          Options: {
            'awslogs-group': `${slsServiceName}-ecs-service`,
            'awslogs-region': options.region,
            'awslogs-stream-prefix': container.name,
          }
        }
      }));

      return {
        [`TaskDefinition`]: {
          Type: 'AWS::ECS::TaskDefinition',
          Properties: {
            ExecutionRoleArn: { Ref: 'ECSTaskExecutionRole' },
            Cpu: config.cpu || 1024,
            Memory: config.memory || 2048,
            NetworkMode: 'awsvpc',
            RequiresCompatibilities: ['FARGATE'],
            ContainerDefinitions: containerDefinitions,
            Family: `${slsServiceName}-ecs-service`
          }
        }
      }
    },

    EcsTaskExecutionRole: () => ({
      'ECSTaskExecutionRole': {
        Type: 'AWS::IAM::Role',
        Properties: {
          AssumeRolePolicyDocument: {
            Statement: [
              {
                Effect: 'Allow',
                Principal: {
                  Service: [
                    'ecs-tasks.amazonaws.com'
                  ]
                },
                Action: [
                  'sts:AssumeRole'
                ]
              }
            ]
          },
          Path: "/",
          Policies: [
            {
              PolicyName: `${slsServiceName}TaskExecution`,
              PolicyDocument: {
                Statement: [
                  {
                    Effect: 'Allow',
                    Action: [
                      'ecr:GetAuthorizationToken',
                      'ecr:BatchCheckLayerAvailability',
                      'ecr:GetDownloadUrlForLayer',
                      'ecr:BatchGetImage',
                      'logs:CreateLogStream',
                      'logs:PutLogEvents'
                    ],
                    Resource: '*'
                  }
                ]
              }
            }
          ]
        }
      }
    }),

    ApiGatewayRestApi: (serviceName, endpointType) => ({
      /**
       * EDGE: For an edge-optimized API and its custom domain name.
       * REGIONAL: For a regional API and its custom domain name.
       * PRIVATE: For a private API.
       */
      [`${serviceName}RestAPI`]: {
        Type: 'AWS::ApiGateway::RestApi',
        Properties: {
          Description: `API for ${serviceName}`,
          Name: serviceName,
          EndpointConfiguration: {
            Types: [endpointType],
          }
        },
      }
    }),

    ApiGatewayStage: () => {},
    ApiGatewayResource: () => {},
    ApiGatewayBasePathMapping: () => {},
    ApiGatewayMethod: () => {},
    HttpsTargetGroup: () => {},
    HttpTargetGroup: () => {},

  }
};
