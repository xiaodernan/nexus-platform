# D851/D852: the deployment image recipe — and the deployment path compose uses. It packages the
# jar the host produced and the smokes already verified (scripts/cloud_smoke.sh, cloud_lb_smoke.sh),
# byte for byte. Rebuild on the host first:
#
#   mvn -B -q -f services/cloud/pom.xml -DskipTests clean package
#
# For a self-contained image that compiles from source inside the build container see
# Dockerfile.build. That path needs a warm Maven Central (the build downloads the reactor's
# dependency tree inside the image); on a cold network it is slow, which is why compose uses
# this file instead. Nothing here rebuilds what the smokes ran — the image IS the verified jar.
ARG MODULE
FROM eclipse-temurin:25-jre
ARG MODULE
WORKDIR /app
COPY ${MODULE}/target/app.jar /app/app.jar
EXPOSE 8080
ENTRYPOINT ["java", "-jar", "/app/app.jar"]
