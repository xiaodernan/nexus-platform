FROM maven:3.9-eclipse-temurin-25 AS build

WORKDIR /src
COPY services/platform/pom.xml services/platform/pom.xml
COPY infra/db/migrations infra/db/migrations
RUN mvn -B -q -f services/platform/pom.xml dependency:go-offline
COPY services/platform/src services/platform/src
RUN mvn -B -q -f services/platform/pom.xml -DskipTests package

FROM eclipse-temurin:25-jre AS runtime

WORKDIR /app
COPY --from=build /src/services/platform/target/nexus-platform.jar app.jar
EXPOSE 8080
ENTRYPOINT ["java", "-jar", "/app/app.jar"]
