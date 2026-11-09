# One image recipe for the three Spring Cloud modules. The module is chosen at build time; the
# multi-module reactor supplies the shared BOM, so `-pl <module> -am` builds exactly one service.
#
#   docker build -f services/cloud/Dockerfile --build-arg MODULE=gateway services/cloud
#
# Java 21 builds (the local image set's maven tag) and Java 25 runs (eclipse-temurin:25-jre),
# matching the parent pom's stated split. No image is pulled by the smoke script: it runs the
# packaged jars on the host, so this file is the deployment path, not the test path.
FROM maven:3.9-eclipse-temurin-21 AS build
ARG MODULE
WORKDIR /src
COPY pom.xml ./
COPY eureka-server/pom.xml eureka-server/pom.xml
COPY config-server/pom.xml config-server/pom.xml
COPY gateway/pom.xml gateway/pom.xml
RUN mvn -q -B -pl ${MODULE} -am -DskipTests package

FROM eclipse-temurin:25-jre
ARG MODULE
WORKDIR /app
COPY --from=build /src/${MODULE}/target/app.jar /app/app.jar
EXPOSE 8080
ENTRYPOINT ["java", "-jar", "/app/app.jar"]
