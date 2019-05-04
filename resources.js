module.exports = {
  LogGroup: () => {},
  EcsService: () => {},
  EcsTaskDefinition: () => {},
  EcsTaskExecutionRole: () => {},

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

};
